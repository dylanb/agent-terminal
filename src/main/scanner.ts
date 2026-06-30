// Semantic scanner (§15.2/§15.3 / D2/D7). Runs ONLY on the active→quiet transition (never per
// chunk, never on a timer). Detection only — it never acts on an event.

import { appendFileSync, writeFileSync } from 'node:fs';
import type { MonitorEventSource, MonitorEventType, SelectionRange } from '../shared/ipc';
import type { ShadowMarker, ShadowReader } from './shadow';
import type { Adapter, DetectedRegion } from './adapters/types';
import type { CommandSpanRange } from './spanTypes';
import { DEFAULT_CHROME_MARKERS, chromeRows, completedTurnFrontier } from './chrome';

// Capture-trace diagnostics path, opt-in via DEBUG=1 (then /tmp/scanner.log, or a SCANNER_DEBUG=<path>
// override). Always off under vitest (VITEST set) so the suite never writes the trace file.
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
  /** Subscribe to the active→quiet transition to AUTO-scan (the streaming-capture path,
   *  §15.3). Omitted ⇒ the scanner is dormant: it never auto-emits and the dedup/watermark
   *  machinery is never touched; capture happens only on demand via captureLast() (§21.1). */
  onQuiet?(cb: () => void): () => void;
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
  /** Text of the tracked shell commands (§15.5). captureLast (§21.1) skips a candidate report
   *  that is just the echoed command line — the user's own input is not "the latest report".
   *  The auto path doesn't need it (its watermark seals past the echo); omitted ⇒ no filter. */
  commandTexts?: () => string[];
}

/** The latest report captured on demand (§21.1): the report region plus its split findings,
 *  each with a stamped on-screen range. parentId is null on all — the caller links findings to
 *  the report's stored id. */
export interface CaptureLastResult {
  report: ScannerEmission;
  findings: ScannerEmission[];
}

export interface Scanner {
  /** Run report-detection once against the CURRENT buffer and return the latest report (§21.1).
   *  Stateless — no watermark, no cross-transition dedup; null when no report is present. */
  captureLast(): CaptureLastResult | null;
  dispose(): void;
}

/** Whitespace-collapsed text so dedup is coordinate- and wrap-free (§15.3). */
function normalize(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

/** Claude Code's end-of-turn "※ recap:" line — the agent's one-line turn summary (toggled by its
 *  own /config), printed below the real output. It is a meta-summary, not the latest report, so
 *  on-demand capture (§21.1) skips it the way it skips an echoed command line. Anchored at the
 *  start of the normalized region so a report that merely names "recap" mid-prose is unaffected. */
const RECAP_LINE = /^※\s*recap:/i;

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

  if (SCANNER_DEBUG) {
    try {
      writeFileSync(SCANNER_DEBUG, `=== scanner session start ${new Date().toISOString()} -> ${SCANNER_DEBUG} ===\n`);
    } catch {
      /* logging must never break capture */
    }
  }

  // Best-effort provenance only — never used to re-extract content (§7.3/§8.4 / §16.8).
  const rangeOf = (startRow: number, endRow: number): SelectionRange => ({
    start: { x: 0, y: startRow },
    end: { x: reader.cols(), y: endRow },
    baseY: reader.baseY(),
    bufferType: reader.bufferType(),
  });

  // The sole disposer of a Captured's start-marker (an xterm IMarker) — every removal path routes
  // here so none leaks a marker.
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
   * Dedup decision for a freshly-detected region (§15.3 / v2.22). Positional identity is primary —
   * a live capture starting on this same row IS this unit re-detected, so only a clean
   * word-boundary growth supersedes; any other edit is an in-place repaint and keeps the first
   * stable capture. With no positional match (new unit, or marker trimmed out of scrollback) it
   * falls back to text identity: exact/subsumed drops; a clean append supersedes the partials it completes.
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
      return { emit: false };
    }
    const retract: Captured[] = [];
    for (const c of captured.values()) {
      if (c.type !== type) continue;
      if (isPrefixAtBoundary(norm, c.norm)) {
        dbg(`    classify[row ${startRow}]: no positional match, SUBSUMED by fuller capture id=${c.id} -> DROP`);
        return { emit: false };
      }
      if (isPrefixAtBoundary(c.norm, norm)) retract.push(c);
    }
    dbg(
      `    classify[row ${startRow}]: NEW unit (no positional match, marker lost or never seen), retract ${retract.length} partial(s)=[${retract.map((c) => c.id).join(',')}] -> EMIT`,
    );
    return { emit: true, retract };
  }

  /**
   * The stability frontier (§15.3 / v2.22, v2.25): the highest row PROVEN immutable this scan,
   * never behind the watermark. The bottom-most detected unit stays PROVISIONAL so a streaming
   * report merges instead of splitting.
   *
   * The bottom unit takes priority over the composer witness (v2.25): Claude Code keeps its
   * rule-framed input composer pinned at the viewport bottom **while it is still streaming** (the
   * strip reads "esc to interrupt"), so a composer below the content is NOT proof the turn is done
   * and the bottom unit can still grow — sealing up to it each quiet pause shredded a streamed
   * report into one chunk per pause. Scrolled-off rows are likewise NOT auto-sealed: a provisional
   * report taller than the viewport keeps its head in scrollback so it re-gathers whole. Trim is
   * handled separately by planScan (watermark.line < 0 ⇒ re-scan, truncated). -1 ⇒ nothing to seal.
   */
  function computeSealRow(altScreen: boolean, startRow: number, endRow: number, bottomUnitStart: number): number {
    const witnessed = altScreen || startRow > endRow ? null : completedTurnFrontier(reader, startRow, endRow);
    let sealRow: number;
    if (bottomUnitStart >= 0) sealRow = bottomUnitStart - 1;
    else if (witnessed !== null) sealRow = witnessed;
    else sealRow = startRow - 1;
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

  /** The shared detection pass (§15.3): classifiers carve structured blocks, then the
   *  glyph-agnostic baseline captures the remaining prose as reports. Pure — no watermark,
   *  dedup or emission. Both the auto-scan (scan) and on-demand capture (captureLast) use it,
   *  so detection is identical whichever trigger fired. Returns the supporting context too so
   *  scan() can keep its per-row capture-trace dump. */
  function detectRegions(startRow: number, endRow: number): {
    allRegions: DetectedRegion[];
    claimed: Set<number>;
    isChrome: (row: number) => boolean;
    markers: readonly string[];
    closedSpans: CommandSpanRange[];
  } {
    const closedSpans = deps.closedSpans?.() ?? [];
    const markers = deps.chromeMarkers?.() ?? DEFAULT_CHROME_MARKERS;
    const isChrome = chromeRows(reader, startRow, endRow, markers);
    const altScreen = reader.bufferType() === 'alternate';
    const ctx = { reader, startRow, endRow, altScreen, closedSpans, reportMinChars: deps.reportMinChars, isChrome };

    // Classifier rows are claimed so the baseline won't also fold them into a report.
    const claimed = new Set<number>();
    const structured: DetectedRegion[] = [];
    for (const adapter of deps.adapters) {
      for (const region of adapter.detect(ctx)) {
        structured.push(region);
        for (let r = region.startRow; r <= region.endRow; r++) claimed.add(r);
      }
    }
    const baseCtx = { ...ctx, isClaimed: (row: number) => claimed.has(row) };
    const reports = deps.baseline?.detect(baseCtx) ?? [];
    return { allRegions: [...structured, ...reports], claimed, isChrome, markers, closedSpans };
  }

  let scanCount = 0;
  function scan() {
    const altScreen = reader.bufferType() === 'alternate';
    const { startRow, truncated } = planScan();
    const endRow = reader.length() - 1;
    let bottomUnitStart = -1; // -1 ⇒ nothing detected; see computeSealRow

    const n = ++scanCount;
    dbg(
      `\n==== SCAN ${n} @ ${new Date().toLocaleTimeString()} | buf=${reader.bufferType()} | win=[${startRow}..${endRow}] ` +
        `baseY=${reader.baseY()} len=${reader.length()} cursor=${reader.cursor().y} wm=${watermark ? watermark.line : 'none'} trunc=${truncated} ====`,
    );

    if (!altScreen && startRow <= endRow) {
      const { allRegions, claimed, isChrome, markers, closedSpans } = detectRegions(startRow, endRow);
      if (allRegions.length > 0) bottomUnitStart = Math.max(...allRegions.map((r) => r.startRow));

      if (SCANNER_DEBUG) {
        dbg(`  markers=${JSON.stringify(markers)} closedSpans=${JSON.stringify(closedSpans.map((s) => [s.startRow, s.endRow]))}`);
        dbg(`  captured set (${captured.size}) [dedup memory carried from prior scans]:`);
        for (const c of captured.values()) {
          dbg(
            `    id=${c.id ?? '(suppressed)'} type=${c.type} marker@${c.startMarker ? c.startMarker.line : 'none'} normLen=${c.norm.length} norm="${c.norm.slice(0, 50)}"`,
          );
        }
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
        // Dedup at the parent level only; findings ride on the parent so identical finding text
        // across different reports never collides (§15.6).
        const norm = normalize(region.text);
        const key = dedupKey(region.type, norm);
        const verdict = classify(region.type, region.startRow, norm, key);
        if (!verdict.emit) {
          dbg(`  DROP  [${region.startRow}..${region.endRow}] (not surfaced this scan)`);
          continue;
        }
        // Retract before suppression so suppressed growth still cleans up the partials it completes.
        for (const c of verdict.retract) {
          dbg(`  RETRACT id=${c.id} (superseded by row ${region.startRow})`);
          if (c.id !== undefined) deps.remove?.(c.id);
          drop(c.key);
        }
        // Echoed self-injected input: remember it so it never re-emits, but don't surface it (§16.5).
        if (deps.isSuppressed?.({ startRow: region.startRow, endRow: region.endRow })) {
          dbg(`  SUPPRESSED [${region.startRow}..${region.endRow}] ${JSON.stringify(region.text.slice(0, 60))}`);
          remember({ key, type: region.type, norm });
          continue;
        }
        // Each finding carries its own range so a chunk highlights alone (§15.4 / §16.8).
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

    // On the alt buffer there is nothing to track — resume from the top when normal returns (§15.3).
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

  // No quiet source wired ⇒ scan/dedup/watermark never run; capture is purely on demand (§21.1).
  const unsub = deps.onQuiet ? deps.onQuiet(scan) : () => {};

  /** Run detection once against the current buffer and return the latest report (§21.1).
   *  Stateless: reads from the top of the buffer (scrollback included), picks the bottom-most
   *  `report` region as "the latest", and stamps each finding's own range (§16.8). */
  function captureLast(): CaptureLastResult | null {
    // The on-demand path reads whatever buffer is live, including a full-screen agent's visible
    // alternate-screen frame (§21.1/§13.4). The auto path stays normal-only via scan()'s guard.
    const endRow = reader.length() - 1;
    if (endRow < 0) return null;
    const { allRegions } = detectRegions(0, endRow);
    // Skip a candidate that IS the echoed command line — the user's own input, not a report (§21.1).
    // Requiring a shell-prompt prefix (not just endsWith) keeps real prose that merely names a
    // command at the end ("…then run npm test").
    const commands = (deps.commandTexts?.() ?? []).map(normalize).filter((c) => c.length > 0);
    const isCommandEcho = (text: string): boolean => {
      const n = normalize(text);
      return commands.some((c) => {
        if (!n.endsWith(c)) return false;
        const prefix = n.slice(0, n.length - c.length);
        return prefix === '' || /[$#%>❯›»]\s*$/.test(prefix);
      });
    };
    let region: DetectedRegion | undefined;
    for (const r of allRegions) {
      if (r.type !== 'report' || isCommandEcho(r.text) || RECAP_LINE.test(normalize(r.text))) continue;
      if (!region || r.startRow > region.startRow) region = r;
    }
    if (!region) return null;
    if (deps.isSuppressed?.({ startRow: region.startRow, endRow: region.endRow })) return null;
    const report: ScannerEmission = {
      type: region.type,
      source: region.source,
      text: region.text,
      parentId: null,
      truncated: false,
      range: rangeOf(region.startRow, region.endRow),
    };
    const findings: ScannerEmission[] = (region.children ?? []).map((child) => ({
      type: child.type,
      source: child.source,
      text: child.text,
      parentId: null,
      truncated: false,
      range: rangeOf(child.startRow, child.endRow),
    }));
    return { report, findings };
  }

  return {
    captureLast,
    dispose() {
      unsub();
      watermark?.dispose();
      for (const c of captured.values()) c.startMarker?.dispose();
    },
  };
}
