// Shadow screen model (§8): every PTY byte is teed here. Owns the headless
// terminal, the quiescence detector, and the debounced status publisher.

import { Terminal as HeadlessTerminal, type IDisposable, type IMarker } from '@xterm/headless';
import type { AgentState, BufferType } from '../shared/ipc';
import { createQuiescenceDetector, QUIET_MS } from './quiescence';

export const SETTLE_MS = 80;

export interface ShadowStatus {
  altScreen: boolean;
  bracketedPaste: boolean;
  agentState: AgentState;
  quietSince: number | null;
}

/**
 * Read-only window onto the headless buffer (§15.2 "public read path"). The
 * terminal itself stays private to createShadowModel — the scanner/tracker only
 * touch the buffer through these accessors, all in absolute-row coordinates.
 */
export interface ShadowReader {
  bufferType(): BufferType;
  /** Total buffer lines (scrollback + viewport). */
  length(): number;
  baseY(): number;
  cols(): number;
  rows(): number;
  /** Absolute cursor position; y is a buffer line index (baseY + cursorY). */
  cursor(): { x: number; y: number };
  /** trimRight defaults true; pass false to keep a wrapped segment's full width (§15.2). */
  lineText(y: number, trimRight?: boolean): string;
  isLineWrapped(y: number): boolean;
}

/** A scrollback watermark; `line` goes -1 once its row trims (§15.2 / D2). */
export type ShadowMarker = IMarker;

export interface ShadowModel {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** Live bracketed-paste mode — read at injection time, never cached (§9.3). */
  isBracketedPaste(): boolean;
  /** Visible-buffer text via the public read path (capture substrate / debugging, §8.2). */
  snapshotText(): string;
  /** Public read path for the semantic scanner (§15.2). */
  reader: ShadowReader;
  /** Fires on each active→quiet transition, after a parse-queue barrier so the buffer reflects all pre-transition bytes (§15.2). */
  onQuiet(cb: () => void): () => void;
  /** Fires on each visible-content-change edge — the same §8.3 signal quiescence keys off (an identical
   *  repaint is NOT an edge). The §27.12 stall watchdog resets its deadline on this so a streaming turn
   *  never stalls while a frozen screen counts down. */
  onActivity(cb: () => void): () => void;
  /** D46 — re-arm the §8.3 quiescence window as if output just occurred: flips to `active` now and
   *  will re-emit `quiet` a full quietMs later. Guarantees a FRESH active→quiet edge for the next
   *  injection even when the agent already settled (no more real output would otherwise re-arm it),
   *  without the hang of waiting for an edge that never comes. */
  noteSettle(): void;
  /** Place a watermark at an absolute buffer row; undefined on the alt buffer (§15.2 / D2). */
  addMarker(absRow: number): ShadowMarker | undefined;
  /** Register an OSC handler (e.g. 133 shell-integration marks, §15.5). */
  onOsc(ident: number, cb: (data: string) => void): () => void;
  dispose(): void;
}

export function createShadowModel(opts: {
  cols?: number;
  rows?: number;
  scrollback?: number;
  settleMs?: number;
  quietMs?: number;
  onStatus: (status: ShadowStatus) => void;
  now?: () => number;
}): ShadowModel {
  const settleMs = opts.settleMs ?? SETTLE_MS;
  const term = new HeadlessTerminal({
    cols: opts.cols ?? 80,
    rows: opts.rows ?? 24,
    scrollback: opts.scrollback ?? 5000,
    allowProposedApi: true,
  });

  let last: ShadowStatus | null = null;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  // §8.3 quiescence keys off *rendered-screen change*, not raw bytes: a full-screen TUI agent repaints
  // its frame on a timer even while idle, so byte-presence would never go quiet. `lastSignature` is the
  // previous visible-screen text; an identical repaint is not activity.
  let lastSignature: string | null = null;
  const quietCbs = new Set<() => void>();
  const activityCbs = new Set<() => void>();
  const oscDisposables: IDisposable[] = [];

  const detector = createQuiescenceDetector({
    quietMs: opts.quietMs ?? QUIET_MS,
    now: opts.now,
    onTransition: (state) => {
      // Transitions publish immediately — don't wait for the settle debounce (§8.3).
      publishStatus();
      // A parse-queue barrier guarantees the buffer reflects all pre-transition bytes (§15.2).
      if (state === 'quiet') term.write('', fireQuiet);
    },
  });

  function fireQuiet() {
    if (disposed) return;
    for (const cb of quietCbs) cb();
  }

  const reader: ShadowReader = {
    bufferType: () => (term.buffer.active.type === 'alternate' ? 'alternate' : 'normal'),
    length: () => term.buffer.active.length,
    baseY: () => term.buffer.active.baseY,
    cols: () => term.cols,
    rows: () => term.rows,
    cursor: () => ({
      x: term.buffer.active.cursorX,
      y: term.buffer.active.baseY + term.buffer.active.cursorY,
    }),
    lineText: (y, trimRight = true) => term.buffer.active.getLine(y)?.translateToString(trimRight) ?? '',
    isLineWrapped: (y) => term.buffer.active.getLine(y)?.isWrapped ?? false,
  };

  // The visible viewport's text (absolute rows baseY..baseY+rows), prefixed with the buffer type so a
  // normal↔alternate switch registers as a change. This is the "did the screen change" signal for §8.3.
  function visibleSignature(): string {
    const buf = term.buffer.active;
    const top = buf.baseY;
    let sig = buf.type;
    for (let y = top; y < top + term.rows; y++) {
      sig += '\n' + (buf.getLine(y)?.translateToString(true) ?? '');
    }
    return sig;
  }

  function currentStatus(): ShadowStatus {
    return {
      altScreen: term.buffer.active.type === 'alternate',
      bracketedPaste: term.modes.bracketedPasteMode,
      agentState: detector.state,
      quietSince: detector.quietSince,
    };
  }

  function publishStatus() {
    if (disposed) return;
    const status = currentStatus();
    if (
      !last ||
      status.altScreen !== last.altScreen ||
      status.bracketedPaste !== last.bracketedPaste ||
      status.agentState !== last.agentState
    ) {
      last = status;
      opts.onStatus(status);
    }
  }

  return {
    write(data) {
      if (disposed) return; // onData can race window close (§4G)
      // Note activity only when the parsed buffer's visible text actually changed (§8.3) — hence inside
      // term.write's post-parse callback, where the just-written bytes are reflected in the screen.
      term.write(data, () => {
        if (disposed) return;
        const sig = visibleSignature();
        if (sig !== lastSignature) {
          lastSignature = sig;
          detector.noteOutputActivity();
          for (const cb of activityCbs) cb();
        }
      });
      if (settleTimer) clearTimeout(settleTimer);
      // Agents redraw in bursts; read shadow state only after writes settle (§8.2).
      settleTimer = setTimeout(publishStatus, settleMs);
    },
    resize(cols, rows) {
      if (disposed) return;
      term.resize(cols, rows);
    },
    isBracketedPaste() {
      return term.modes.bracketedPasteMode;
    },
    snapshotText() {
      const buf = term.buffer.active;
      const lines: string[] = [];
      for (let y = 0; y < buf.length; y++) {
        lines.push(buf.getLine(y)?.translateToString(true) ?? '');
      }
      return lines.join('\n');
    },
    reader,
    onQuiet(cb) {
      quietCbs.add(cb);
      return () => quietCbs.delete(cb);
    },
    onActivity(cb) {
      activityCbs.add(cb);
      return () => activityCbs.delete(cb);
    },
    noteSettle() {
      if (disposed) return;
      detector.noteOutputActivity();
    },
    addMarker(absRow) {
      if (disposed || reader.bufferType() === 'alternate') return undefined;
      const buf = term.buffer.active;
      return term.registerMarker(absRow - (buf.baseY + buf.cursorY));
    },
    onOsc(ident, cb) {
      // Handler fires mid-parse, so reader.cursor() in cb is the mark position (D4).
      const d = term.parser.registerOscHandler(ident, (data) => {
        cb(data);
        return true;
      });
      oscDisposables.push(d);
      return () => d.dispose();
    },
    dispose() {
      disposed = true;
      if (settleTimer) clearTimeout(settleTimer);
      for (const d of oscDisposables) d.dispose();
      quietCbs.clear();
      activityCbs.clear();
      detector.dispose();
      term.dispose();
    },
  };
}
