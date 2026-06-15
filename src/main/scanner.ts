// Semantic scanner (§15.2/§15.3 / D2/D7). Runs ONLY on the active→quiet
// transition (never per chunk, never on a timer), reads the full buffer including
// scrollback via a marker watermark, dispatches to adapters, dedups by content,
// and emits widened MonitorEvents. Detection only — it never acts on an event.

import { appendFileSync, writeFileSync } from 'node:fs';
import type { MonitorEventSource, MonitorEventType, SelectionRange } from '../shared/ipc';
import type { ShadowMarker, ShadowReader } from './shadow';
import type { Adapter } from './adapters/types';
import type { CommandSpanRange } from './spanTypes';
import { DEFAULT_CHROME_MARKERS, chromeRows, completedTurnFrontier } from './chrome';

// Capture-trace diagnostics: dumps every scan's window, per-row classification, detected
// regions, dedup verdicts and seal to a file — the ground truth for debugging why a report
// split, merged, or dropped a line. Opt-in via DEBUG=1 (then /tmp/scanner.log, or a
// SCANNER_DEBUG=<path> override); off otherwise, and always off under vitest (VITEST is
// set) so the suite never writes it. The file truncates fresh each app launch (see
// createScanner). Logging never throws into the capture path.
export function resolveScannerDebugPath(env: NodeJS.ProcessEnv): string | undefined {
  if (env.VITEST) return undefined;
  if (env.DEBUG !== '1') return undefined;
  return env.SCANNER_DEBUG ?? '/tmp/scanner.log';
}
const SCANNER_DEBUG = resolveScannerDebugPath(process.env);
function dbg(line: string): void {
  if (!SCANNER_DEBUG) return;
  try {
    appendFileSync(SCANNER_DEBUG, line + '\n');
  } catch {
    /* logging must never break capture */
  }
}

export interface ScannerEmission {
  type: MonitorEventType;
  source: MonitorEventSource;
  text: string;
  /** A finding's parent report id; null for top-level events (§15.6 / v2.6). */
  parentId: string | null;
  truncated: boolean;
  /** Where this region sits on screen (absolute buffer rows) so the pane can scroll/
   *  highlight back to it (§15.4). Best-effort provenance — set for top-level regions,
   *  null for findings (which ride their parent) and the alt buffer. */
  range: SelectionRange | null;
}

/** Persists the emission and returns its stamped event id (so findings can link to a report). */
export type ScannerEmit = (e: ScannerEmission) => string;

export interface ScannerDeps {
  reader: ShadowReader;
  addMarker(absRow: number): ShadowMarker | undefined;
  onQuiet(cb: () => void): () => void;
  /** Per-agent classifiers (enrichment): each carves out its structured blocks
   *  (tool-use / diff). Every classifier runs every scan — no fingerprint/selection. */
  adapters: Adapter[];
  /** The glyph-agnostic baseline: captures substantial new non-chrome prose as reports.
   *  Always runs, after the classifiers, over the rows they did not claim (§15.3). */
  baseline?: Adapter;
  dedupRetention: number;
  /** Minimum report size (chars) before a `report` is emitted (§15.3 / §15.7). */
  reportMinChars: number;
  emit: ScannerEmit;
  /**
   * Retract a previously-emitted top-level event when a later scan supersedes it
   * (its text is an exact prefix of the new region's — §15.3). Omitted ⇒ no retraction.
   */
  remove?: (id: string) => void;
  closedSpans?: () => CommandSpanRange[];
  /** Drops echoed self-injected input from emission (§16.5); omitted ⇒ no suppression. */
  isSuppressed?: (region: { startRow: number; endRow: number }) => boolean;
  /** Active chrome markers (§15.x) — leading glyphs that flag a line as agent-UI
   *  furniture. Grown by the user "marking as chrome"; omitted ⇒ the stock seed. */
  chromeMarkers?: () => readonly string[];
}

export interface Scanner {
  dispose(): void;
}

/** Whitespace-collapsed text so dedup is coordinate- and wrap-free (§15.3). */
function normalize(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

/** Coordinate-free dedup key so a region survives scrollback trim (§15.3). */
function dedupKey(type: MonitorEventType, norm: string): string {
  // `::` cannot collide: MonitorEventType is a fixed kebab-case enum with no colons.
  return `${type}::${norm}`;
}

/** True when `a` is a proper prefix of `b` ending on a word boundary — the shape a
 *  report's earlier partial has against its later, fuller re-capture (§15.3). */
function isPrefixAtBoundary(a: string, b: string): boolean {
  return b.length > a.length && b.startsWith(a + ' ');
}

/** A captured top-level region retained for dedup. Identity is positional: `startMarker`
 *  tracks the region's first row through scroll, so a re-detected region at the same row is
 *  the SAME unit (§15.3 / v2.22). `norm`/`key` are the content backstop for when the marker
 *  trims out of scrollback and the position is lost. */
interface Captured {
  key: string;
  type: MonitorEventType;
  norm: string;
  /** The emitted event id; absent for suppressed entries that were never surfaced (§16.5). */
  id?: string;
  /** Marker on the region's first row; absent for suppressed entries (§16.5). */
  startMarker?: ShadowMarker;
}

/** The dedup decision for a freshly-detected region (§15.3 / v2.22): drop it (already
 *  shown), or emit it after retracting the captures it supersedes (possibly none). */
type DedupVerdict = { emit: false } | { emit: true; retract: Captured[] };

export function createScanner(deps: ScannerDeps): Scanner {
  const { reader, addMarker, emit } = deps;
  let watermark: ShadowMarker | undefined;
  const captured = new Map<string, Captured>();
  const order: string[] = [];

  // Start each app session with a fresh capture-trace log (see SCANNER_DEBUG).
  if (SCANNER_DEBUG) {
    try {
      writeFileSync(SCANNER_DEBUG, `=== scanner session start ${new Date().toISOString()} -> ${SCANNER_DEBUG} ===\n`);
    } catch {
      /* logging must never break capture */
    }
  }

  // A region's on-screen span (absolute buffer rows) so the pane can scroll/highlight back
  // to it (§16.8). Best-effort provenance — never used to re-extract content (§7.3/§8.4).
  const rangeOf = (startRow: number, endRow: number): SelectionRange => ({
    start: { x: 0, y: startRow },
    end: { x: reader.cols(), y: endRow },
    baseY: reader.baseY(),
    bufferType: 'normal',
  });

  // Dropping a capture means releasing its start-marker (an xterm IMarker): the single
  // place that knows what a Captured owns, so no removal path leaks a marker.
  function drop(key: string) {
    captured.get(key)?.startMarker?.dispose();
    captured.delete(key);
    const i = order.indexOf(key);
    if (i >= 0) order.splice(i, 1);
  }

  function remember(entry: Captured) {
    captured.set(entry.key, entry);
    order.push(entry.key);
    while (order.length > deps.dedupRetention) {
      const evicted = order.shift();
      if (evicted !== undefined) drop(evicted);
    }
  }

  /** A live capture whose first row sits exactly where this region begins — the SAME unit
   *  re-detected (§15.3 / v2.22). Trimmed markers (line < 0) never match a real row. */
  function positionMatch(type: MonitorEventType, startRow: number): Captured | undefined {
    for (const c of captured.values()) {
      if (c.type === type && c.startMarker && c.startMarker.line === startRow) return c;
    }
    return undefined;
  }

  /**
   * Dedup decision for a freshly-detected region (§15.3 / v2.22). Mutation is the ground
   * truth, not text similarity. Positional identity is primary — a live capture starting on
   * this same row IS this unit re-detected:
   *   unchanged     → already shown (drop);
   *   clean growth  → the partial grew, supersede it (emit, retracting the partial);
   *   any other edit → an in-place repaint (elapsed/progress token, reflow), keep the first
   *                    stable capture (drop).
   * With no positional match (a new unit, or one whose marker trimmed out of scrollback so
   * its position is lost) it falls back to text identity: an exact or subsumed match drops;
   * a clean word-boundary append supersedes every captured partial it completes.
   */
  function classify(type: MonitorEventType, startRow: number, norm: string, key: string): DedupVerdict {
    const pos = positionMatch(type, startRow);
    if (pos) {
      if (pos.norm === norm) {
        dbg(`    classify[row ${startRow}]: POSITIONAL match id=${pos.id} (marker@${pos.startMarker?.line}) UNCHANGED -> DROP`);
        return { emit: false };
      }
      if (isPrefixAtBoundary(pos.norm, norm)) {
        dbg(`    classify[row ${startRow}]: POSITIONAL match id=${pos.id} CLEAN-GROWTH (+${norm.length - pos.norm.length} chars) -> EMIT, retract id=${pos.id}`);
        return { emit: true, retract: [pos] };
      }
      dbg(
        `    classify[row ${startRow}]: POSITIONAL match id=${pos.id} DIRTY-REWRITE (not a clean append) -> DROP, keep first stable capture` +
          `\n        prev="${pos.norm.slice(0, 80)}"\n        now ="${norm.slice(0, 80)}"`,
      );
      return { emit: false };
    }
    if (captured.has(key)) {
      dbg(`    classify[row ${startRow}]: no positional match, but EXACT content key already captured -> DROP`);
      return { emit: false }; // exact content match already captured
    }
    const retract: Captured[] = [];
    for (const c of captured.values()) {
      if (c.type !== type) continue;
      if (isPrefixAtBoundary(norm, c.norm)) {
        dbg(`    classify[row ${startRow}]: no positional match, SUBSUMED by fuller capture id=${c.id} -> DROP`);
        return { emit: false }; // subsumed by a fuller capture
      }
      if (isPrefixAtBoundary(c.norm, norm)) retract.push(c); // this region completes c
    }
    dbg(
      `    classify[row ${startRow}]: NEW unit (no positional match, marker lost or never seen), retract ${retract.length} partial(s)=[${retract.map((c) => c.id).join(',')}] -> EMIT`,
    );
    return { emit: true, retract };
  }

  /**
   * The stability frontier (§15.3 / v2.22, v2.25): the highest row PROVEN immutable this scan.
   * It sits just above the bottom-most detected unit (which stays PROVISIONAL — re-scannable —
   * so a streaming report merges instead of splitting); else, with no content unit below it,
   * just above the turn-complete composer it witnesses; else just above the scan window.
   *
   * The bottom unit takes priority over the composer witness (v2.25): Claude Code keeps its
   * rule-framed input composer pinned at the viewport bottom **while it is still streaming**
   * (the strip reads "esc to interrupt"), so a composer below the content is NOT proof the
   * turn is done and the bottom unit can still grow. Sealing up to that composer each quiet
   * pause is what shredded a streamed report into one chunk per pause. The witness now only
   * advances the frontier past TRAILING CHROME when no content unit sits above it.
   *
   * Advances only (never behind the watermark). Scrolled-off rows are NOT auto-sealed: a
   * provisional report taller than the viewport keeps its head in scrollback, where its marker
   * stays valid until trimmed — so it re-gathers whole and merges instead of splitting per
   * screen (the removed `baseY-1` floor used to seal every screenful into its own report).
   * Trim is handled separately by planScan (watermark.line < 0 ⇒ re-scan, truncated).
   * -1 ⇒ nothing to seal yet.
   */
  function computeSealRow(altScreen: boolean, startRow: number, endRow: number, bottomUnitStart: number): number {
    const witnessed = altScreen || startRow > endRow ? null : completedTurnFrontier(reader, startRow, endRow);
    let sealRow: number;
    if (bottomUnitStart >= 0) sealRow = bottomUnitStart - 1; // keep the bottom unit provisional
    else if (witnessed !== null) sealRow = witnessed; // no content unit — seal trailing chrome
    else sealRow = startRow - 1; // nothing detected — don't advance into unscanned rows
    return Math.max(sealRow, watermark && watermark.line >= 0 ? watermark.line : -1);
  }

  /** Drop captures whose start-marker has trimmed out of scrollback (line < 0) and report
   *  whether any had — the edge-trigger for truncation when there is no seal frontier (A2). */
  function gcTrimmedCaptures(): boolean {
    let trimmed = false;
    for (const c of [...captured.values()]) {
      if (c.startMarker && c.startMarker.line < 0) {
        trimmed = true;
        drop(c.key);
      }
    }
    return trimmed;
  }

  /** The scan window's first row and whether scrollback trimmed under us this tick, by
   *  watermark state (§15.3 / v2.22):
   *   • no frontier yet — scan from the top; truncated iff a captured unit has since trimmed;
   *   • frontier itself trimmed (line < 0) — scrollback scrolled past the seal, so re-scan
   *     from the top and stamp the whole scan truncated (conservative — A2);
   *   • frontier intact — scan strictly past it, nothing lost. */
  function planScan(): { startRow: number; truncated: boolean } {
    if (!watermark) return { startRow: 0, truncated: gcTrimmedCaptures() };
    if (watermark.line < 0) return { startRow: 0, truncated: true };
    return { startRow: watermark.line + 1, truncated: false };
  }

  let scanCount = 0;
  function scan() {
    const altScreen = reader.bufferType() === 'alternate';
    // Stability frontier (§15.3 / v2.22): the scan opens strictly past the watermark — the
    // highest row PROVEN immutable. The bottom-most unit with no turn-complete witness stays
    // PROVISIONAL (re-scanned, not sealed), so a report paused mid-stream merges instead of
    // splitting; re-examination is positional, with content dedup as the scrollback backstop.
    const { startRow, truncated } = planScan();
    const endRow = reader.length() - 1;
    // The lowest row of the bottom-most unit we own this scan — everything ABOVE it is
    // witnessed done (more content follows) and gets sealed; this unit itself stays
    // provisional unless a composer proves the turn complete. -1 ⇒ nothing detected.
    let bottomUnitStart = -1;

    const n = ++scanCount;
    dbg(
      `\n==== SCAN ${n} @ ${new Date().toLocaleTimeString()} | buf=${reader.bufferType()} | win=[${startRow}..${endRow}] ` +
        `baseY=${reader.baseY()} len=${reader.length()} cursor=${reader.cursor().y} wm=${watermark ? watermark.line : 'none'} trunc=${truncated} ====`,
    );

    if (!altScreen && startRow <= endRow) {
      const closedSpans = deps.closedSpans?.() ?? [];
      // Chrome (§15.x): the bottom-anchored, rule-framed composer, any line whose leading
      // glyph is a profile marker, and the indented continuations beneath such a line.
      // All signals are theme-independent, so adapters skip furniture without a literal glyph.
      const markers = deps.chromeMarkers?.() ?? DEFAULT_CHROME_MARKERS;
      const isChrome = chromeRows(reader, startRow, endRow, markers);
      const ctx = { reader, startRow, endRow, altScreen, closedSpans, reportMinChars: deps.reportMinChars, isChrome };

      // Enrichment first: every classifier carves out its structured blocks (tool-use /
      // diff). Their rows are claimed so the baseline won't also fold them into a report.
      const claimed = new Set<number>();
      const structured: ReturnType<Adapter['detect']> = [];
      for (const adapter of deps.adapters) {
        for (const region of adapter.detect(ctx)) {
          structured.push(region);
          for (let r = region.startRow; r <= region.endRow; r++) claimed.add(r);
        }
      }
      // Then the always-on, glyph-agnostic baseline captures the remaining prose as
      // reports. Capture never hinges on an agent's themeable bullet, so a `⏺`→`●` change
      // (or any unrecognized structure) can't cost us a capture (§15.x).
      const baseCtx = { ...ctx, isClaimed: (row: number) => claimed.has(row) };
      const reports = deps.baseline?.detect(baseCtx) ?? [];

      const allRegions = [...structured, ...reports];
      if (allRegions.length > 0) bottomUnitStart = Math.max(...allRegions.map((r) => r.startRow));

      if (SCANNER_DEBUG) {
        dbg(`  markers=${JSON.stringify(markers)} closedSpans=${JSON.stringify(closedSpans.map((s) => [s.startRow, s.endRow]))}`);
        dbg(`  captured set (${captured.size}) [dedup memory carried from prior scans]:`);
        for (const c of captured.values()) {
          dbg(
            `    id=${c.id ?? '(suppressed)'} type=${c.type} marker@${c.startMarker ? c.startMarker.line : 'none'} normLen=${c.norm.length} norm="${c.norm.slice(0, 50)}"`,
          );
        }
        // Per-row window dump (capped so a from-top rescan can't flood the log).
        const CAP = 250;
        const dump = (y: number) => {
          const t = reader.lineText(y);
          const k = isChrome(y)
            ? 'CHROME'
            : claimed.has(y)
              ? 'CLAIM '
              : closedSpans.some((s) => y >= s.startRow && y <= s.endRow)
                ? 'SPAN  '
                : /[\p{L}\p{N}]/u.test(t)
                  ? 'prose '
                  : 'blank ';
          const wrapped = reader.isLineWrapped(y) ? ' ↩' : '';
          dbg(`  [${String(y).padStart(4)}] ${k} ${JSON.stringify(t.slice(0, 76))}${wrapped}`);
        };
        if (endRow - startRow + 1 <= CAP) {
          for (let y = startRow; y <= endRow; y++) dump(y);
        } else {
          for (let y = startRow; y < startRow + CAP / 2; y++) dump(y);
          dbg(`  … ${endRow - startRow + 1 - CAP} rows elided …`);
          for (let y = endRow - CAP / 2 + 1; y <= endRow; y++) dump(y);
        }
        dbg(`  detected regions (${allRegions.length}), bottomUnitStart=${bottomUnitStart}:`);
        for (const r of allRegions) {
          const lines = r.text.split('\n');
          dbg(
            `    [${r.startRow}..${r.endRow}] ${r.type} ${lines.length}L children=${r.children?.length ?? 0}` +
              ` first="${(lines[0] ?? '').slice(0, 50)}" last="${(lines[lines.length - 1] ?? '').slice(0, 50)}"`,
          );
        }
        dbg(`  --- emit loop ---`);
      }

      for (const region of allRegions) {
        // Dedup at the parent level only; findings ride on the parent so identical
        // finding text across different reports never collides, and an unchanged
        // report (and its findings) is skipped wholesale on the next scan.
        const norm = normalize(region.text);
        const key = dedupKey(region.type, norm);
        const verdict = classify(region.type, region.startRow, norm, key);
        if (!verdict.emit) {
          dbg(`  DROP  [${region.startRow}..${region.endRow}] (not surfaced this scan)`);
          continue; // already shown — drop this capture
        }
        // Retract every partial this region completes so the pane keeps only the
        // fuller capture; happens before suppression so suppressed growth still cleans up.
        for (const c of verdict.retract) {
          dbg(`  RETRACT id=${c.id} (superseded by row ${region.startRow})`);
          if (c.id !== undefined) deps.remove?.(c.id);
          drop(c.key);
        }
        // Echoed self-injected input: remember it so it never re-emits, but don't
        // surface it; the agent's reply renders below the watermark and still does (§16.5).
        if (deps.isSuppressed?.({ startRow: region.startRow, endRow: region.endRow })) {
          dbg(`  SUPPRESSED [${region.startRow}..${region.endRow}] ${JSON.stringify(region.text.slice(0, 60))}`);
          remember({ key, type: region.type, norm });
          continue;
        }
        // Stamp the region's on-screen span so the pane can scroll/highlight back to it
        // (§15.4 / §16.8); each finding carries its own span so a chunk highlights alone.
        const parentId = emit({
          type: region.type,
          source: region.source,
          text: region.text,
          parentId: null,
          truncated,
          range: rangeOf(region.startRow, region.endRow),
        });
        dbg(
          `  EMIT id=${parentId} [${region.startRow}..${region.endRow}] ${region.text.split('\n').length}L children=${region.children?.length ?? 0} ${JSON.stringify(region.text.slice(0, 60))}`,
        );
        remember({ key, type: region.type, norm, id: parentId, startMarker: addMarker(region.startRow) });
        for (const child of region.children ?? []) {
          const childId = emit({
            type: child.type,
            source: child.source,
            text: child.text,
            parentId,
            truncated,
            range: rangeOf(child.startRow, child.endRow),
          });
          dbg(`    └ FINDING id=${childId} [${child.startRow}..${child.endRow}] ${JSON.stringify(child.text.slice(0, 50))}`);
        }
      }
    } else if (SCANNER_DEBUG) {
      dbg(`  (skipped detection: altScreen=${altScreen} startRow=${startRow} endRow=${endRow})`);
    }

    // Advance the watermark to the stability frontier, never backward (§15.3 / v2.22).
    // On the alt buffer there is nothing to track — resume from the top when normal returns.
    const witnessed =
      altScreen || startRow > endRow ? null : completedTurnFrontier(reader, startRow, endRow);
    const sealRow = computeSealRow(altScreen, startRow, endRow, bottomUnitStart);
    dbg(
      `  SEAL: witnessed=${witnessed} bottomUnitStart=${bottomUnitStart} sealRow=${sealRow} ` +
        `-> wm'=${altScreen || sealRow < 0 ? 'none' : sealRow}`,
    );
    watermark?.dispose();
    watermark = altScreen || sealRow < 0 ? undefined : addMarker(sealRow);
  }

  const unsub = deps.onQuiet(scan);

  return {
    dispose() {
      unsub();
      watermark?.dispose();
      for (const c of captured.values()) c.startMarker?.dispose();
    },
  };
}
