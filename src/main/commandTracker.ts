// Command-output capture (§15.5 / D4). Segments the stream into command spans
// using OSC 133 marks (A prompt-start, B command-start, C output-start,
// D;exit finished). Independent of quiescence — it keys off marks, not the §8.3
// machinery. OSC handlers fire mid-parse, so the cursor at handler time is the
// mark position; each mark records {marker, col} for durable, trim-aware extraction.
//
// Marks are UNTRUSTED (§ threat model): anything in the stream can emit them.
// The state machine therefore never crashes or wedges on adversarial ordering,
// and resource use is bounded by named caps (no IMarker leaks on eviction).

import { randomUUID } from 'node:crypto';
import type { ShadowMarker, ShadowReader } from './shadow';
import type { CommandSpanRange } from './spanTypes';
import { extractText } from './extraction';

interface Mark {
  marker: ShadowMarker;
  col: number;
}

interface Span {
  id: string;
  command: string;
  exitCode: number | null;
  running: boolean;
  startedAt: number;
  truncated: boolean;
  outStart: Mark;
  outEnd: Mark | null;
}

/** Summary minus the IPC sessionId, which the wiring layer stamps (§15.4). */
export interface CommandSpanSummary {
  id: string;
  command: string;
  exitCode: number | null;
  running: boolean;
  startedAt: number;
  truncated: boolean;
}

export interface CommandCapture {
  text: string;
  truncated: boolean;
}

export interface CommandTrackerDeps {
  reader: ShadowReader;
  addMarker(absRow: number): ShadowMarker | undefined;
  onOsc(ident: number, cb: (data: string) => void): () => void;
  config: {
    maxOpenSpans: number;
    maxCommandSummaries: number;
    maxExtractedRows: number;
  };
  now?: () => number;
}

export interface CommandTracker {
  summaries(): CommandSpanSummary[];
  /** Drop finished commands, keeping any still-running one (§16.2); disposes the dropped markers. */
  clear(): void;
  capture(id: string): CommandCapture | undefined;
  /** Output ranges of finished spans, for scanner gating (§15.6). */
  closedSpans(): CommandSpanRange[];
  onChange(cb: () => void): () => void;
  dispose(): void;
}

export function createCommandTracker(deps: CommandTrackerDeps): CommandTracker {
  const { reader, addMarker, config } = deps;
  const now = deps.now ?? Date.now;
  const spans: Span[] = [];
  let pendingB: Mark | null = null;
  const changeCbs = new Set<() => void>();

  function emitChange() {
    for (const cb of changeCbs) cb();
  }

  function disposeSpan(span: Span) {
    span.outStart.marker.dispose();
    span.outEnd?.marker.dispose();
  }

  /**
   * Extract rows from a start mark up to an end boundary — the next mark's row,
   * or (for an open span) the live cursor. A boundary at column 0 sits on a fresh
   * line, so its row is excluded; otherwise the partial row is sliced at its column.
   */
  function between(start: Mark, end: Mark | null): CommandCapture {
    let truncated = false;
    let sRow = start.marker.line;
    if (sRow < 0) {
      // Start trimmed past the watermark — best-effort from the viewport top.
      sRow = reader.baseY();
      truncated = true;
    }

    let endRow: number;
    let endCol: number;
    if (end) {
      const er = end.marker.line;
      if (er < 0) {
        truncated = true;
        endRow = reader.length() - 1;
        endCol = 0;
      } else {
        endRow = er;
        endCol = end.col;
      }
    } else {
      const cur = reader.cursor(); // open span → output so far
      endRow = cur.y;
      endCol = cur.x;
    }

    let eRow: number;
    let eCol: number | undefined;
    if (endCol === 0 && endRow - 1 >= sRow) {
      eRow = endRow - 1;
    } else {
      eRow = endRow;
      eCol = endCol;
    }

    if (eRow - sRow + 1 > config.maxExtractedRows) {
      eRow = sRow + config.maxExtractedRows - 1;
      eCol = undefined;
      truncated = true;
    }
    if (eRow < sRow) return { text: '', truncated };

    const text = extractText(reader, { startRow: sRow, endRow: eRow, startCol: start.col, endCol: eCol });
    return { text, truncated };
  }

  function markHere(): Mark | undefined {
    const cur = reader.cursor();
    const marker = addMarker(cur.y);
    if (!marker) return undefined; // alt buffer or disposed shadow — drop the mark
    return { marker, col: cur.x };
  }

  function evictOpenSpansIfNeeded() {
    let open = spans.filter((s) => s.running).length;
    while (open > config.maxOpenSpans) {
      const oldest = spans.findIndex((s) => s.running);
      if (oldest < 0) break;
      const [evicted] = spans.splice(oldest, 1);
      if (pendingB && pendingB.marker.id === evicted.outStart.marker.id) pendingB = null;
      disposeSpan(evicted);
      open--;
    }
  }

  function retainSummaries() {
    while (spans.length > config.maxCommandSummaries) {
      const [dropped] = spans.splice(0, 1);
      disposeSpan(dropped);
    }
  }

  function onPromptStart() {
    /* OSC 133;A — prompt start; no state to record this phase. */
  }

  function onCommandStart() {
    const mark = markHere();
    if (!mark) return;
    if (pendingB) pendingB.marker.dispose(); // B-after-B: discard the prior open start
    pendingB = mark;
  }

  function onOutputStart() {
    if (!pendingB) return; // C-without-B
    const outStart = markHere();
    if (!outStart) {
      pendingB.marker.dispose();
      pendingB = null;
      return;
    }
    const command = between(pendingB, outStart);
    const span: Span = {
      id: randomUUID(),
      command: command.text,
      exitCode: null,
      running: true,
      startedAt: now(),
      truncated: command.truncated,
      outStart,
      outEnd: null,
    };
    pendingB.marker.dispose(); // command text is extracted eagerly; B no longer needed
    pendingB = null;
    spans.push(span);
    evictOpenSpansIfNeeded();
    retainSummaries();
    emitChange();
  }

  function onFinished(data: string) {
    const open = [...spans].reverse().find((s) => s.running);
    if (!open) return; // D with no open span
    const outEnd = markHere();
    if (outEnd) open.outEnd = outEnd;
    const code = Number(data.split(';')[1]);
    open.exitCode = Number.isInteger(code) ? code : null;
    open.running = false;
    emitChange();
  }

  const unsub = deps.onOsc(133, (data) => {
    switch (data[0]) {
      case 'A':
        onPromptStart();
        break;
      case 'B':
        onCommandStart();
        break;
      case 'C':
        onOutputStart();
        break;
      case 'D':
        onFinished(data);
        break;
    }
  });

  return {
    summaries() {
      return spans.map((s) => ({
        id: s.id,
        command: s.command,
        exitCode: s.exitCode,
        running: s.running,
        startedAt: s.startedAt,
        truncated: s.truncated,
      }));
    },
    clear() {
      // Clear only finished commands; a still-running command (and any in-flight
      // command-start) survives until it finishes (§16.2).
      for (let i = spans.length - 1; i >= 0; i--) {
        if (spans[i].running) continue;
        disposeSpan(spans[i]);
        spans.splice(i, 1);
      }
      emitChange();
    },
    capture(id) {
      const span = spans.find((s) => s.id === id);
      if (!span) return undefined; // fail-closed: unknown / stale id
      if (span.outStart.marker.line < 0) return undefined; // trimmed past watermark
      const out = between(span.outStart, span.outEnd);
      return { text: out.text, truncated: out.truncated || span.truncated };
    },
    closedSpans() {
      const ranges: CommandSpanRange[] = [];
      for (const s of spans) {
        if (s.running) continue;
        const sRow = s.outStart.marker.line;
        if (sRow < 0) continue;
        const eRow = s.outEnd && s.outEnd.marker.line >= 0 ? s.outEnd.marker.line : reader.length() - 1;
        ranges.push({ startRow: sRow, endRow: Math.max(sRow, eRow) });
      }
      return ranges;
    },
    onChange(cb) {
      changeCbs.add(cb);
      return () => changeCbs.delete(cb);
    },
    dispose() {
      unsub();
      changeCbs.clear();
      if (pendingB) pendingB.marker.dispose();
      for (const s of spans) disposeSpan(s);
      spans.length = 0;
    },
  };
}
