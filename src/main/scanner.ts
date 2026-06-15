// Semantic scanner (§15.2/§15.3 / D2/D7). Runs ONLY on the active→quiet
// transition (never per chunk, never on a timer), reads the full buffer including
// scrollback via a marker watermark, dispatches to adapters, dedups by content,
// and emits widened MonitorEvents. Detection only — it never acts on an event.

import type { MonitorEventSource, MonitorEventType } from '../shared/ipc';
import type { ShadowMarker, ShadowReader } from './shadow';
import type { Adapter } from './adapters/types';
import type { CommandSpanRange } from './spanTypes';
import { DEFAULT_CHROME_MARKERS, chromeRows, composerTop } from './chrome';

export interface ScannerEmission {
  type: MonitorEventType;
  source: MonitorEventSource;
  text: string;
  /** A finding's parent report id; null for top-level events (§15.6 / v2.6). */
  parentId: string | null;
  truncated: boolean;
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

export function createScanner(deps: ScannerDeps): Scanner {
  const { reader, addMarker, emit } = deps;
  let watermark: ShadowMarker | undefined;
  const captured = new Map<string, Captured>();
  const order: string[] = [];

  function remember(entry: Captured) {
    captured.set(entry.key, entry);
    order.push(entry.key);
    while (order.length > deps.dedupRetention) {
      const evicted = order.shift();
      if (evicted !== undefined) {
        captured.get(evicted)?.startMarker?.dispose();
        captured.delete(evicted);
      }
    }
  }

  function forget(key: string) {
    captured.get(key)?.startMarker?.dispose();
    captured.delete(key);
    const i = order.indexOf(key);
    if (i >= 0) order.splice(i, 1);
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
   *   unchanged     → already shown (null, drop);
   *   clean growth  → the partial grew, supersede it ([pos], retract then re-emit);
   *   any other edit → an in-place repaint (elapsed/progress token, reflow), keep the first
   *                    stable capture (null, drop).
   * With no positional match (a new unit, or one whose marker trimmed out of scrollback so
   * its position is lost) it falls back to text identity: an exact or subsumed match drops;
   * a clean word-boundary append supersedes every captured partial it completes.
   *
   * Returns the captures this region supersedes (to retract — possibly empty), or null when
   * the region is already shown and should be dropped.
   */
  function supersededBy(type: MonitorEventType, startRow: number, norm: string, key: string): Captured[] | null {
    const pos = positionMatch(type, startRow);
    if (pos) {
      if (pos.norm === norm) return null;
      return isPrefixAtBoundary(pos.norm, norm) ? [pos] : null;
    }
    if (captured.has(key)) return null; // exact content match already captured
    const retract: Captured[] = [];
    for (const c of captured.values()) {
      if (c.type !== type) continue;
      if (isPrefixAtBoundary(norm, c.norm)) return null; // subsumed by a fuller capture — drop
      if (isPrefixAtBoundary(c.norm, norm)) retract.push(c); // this region completes c
    }
    return retract;
  }

  /**
   * The stability frontier (§15.3 / v2.22): the highest row PROVEN immutable this scan.
   * It sits just above the turn-complete composer when one witnesses the rows above it as
   * done; else just above the bottom-most provisional unit (which stays re-scannable so a
   * paused report merges instead of splitting); else just above the scan window. Never below
   * scrollback (`baseY-1`, no longer cursor-addressable) and never behind the watermark. The
   * composer is consulted once. -1 ⇒ nothing to seal yet.
   */
  function computeSealRow(altScreen: boolean, startRow: number, endRow: number, bottomUnitStart: number): number {
    const composerRow = !altScreen && startRow <= endRow ? composerTop(reader, startRow, endRow) : endRow + 1;
    let sealRow: number;
    if (composerRow <= endRow) sealRow = composerRow - 1;
    else if (bottomUnitStart >= 0) sealRow = bottomUnitStart - 1;
    else sealRow = startRow - 1; // nothing detected — don't advance into unscanned rows
    return Math.max(sealRow, reader.baseY() - 1, watermark && watermark.line >= 0 ? watermark.line : -1);
  }

  function scan() {
    const altScreen = reader.bufferType() === 'alternate';
    // Stability frontier (§15.3 / v2.22): the watermark marks the highest row PROVEN
    // immutable — scrollback (cannot be cursor-addressed) or content witnessed done by the
    // turn-complete composer below it. The scan opens strictly past it; the bottom-most unit
    // with no witness stays PROVISIONAL (re-scanned, not sealed), so a report paused
    // mid-stream merges instead of splitting. Re-examination is positional (the unit's
    // start-marker), with content dedup as the backstop once a marker trims out of scrollback.
    let startRow: number;
    let truncated = false;
    if (!watermark) {
      startRow = 0;
      // No seal frontier: any captured unit that has since trimmed means content scrolled
      // out from under us. Flag truncation, edge-triggered (forget so it fires once — A2).
      for (const c of [...captured.values()]) {
        if (c.startMarker && c.startMarker.line < 0) {
          truncated = true;
          forget(c.key);
        }
      }
    } else if (watermark.line < 0) {
      // Scrollback trimmed past the watermark — re-scan from the top and stamp
      // every event from this scan truncated (conservative, scan-wide — A2).
      startRow = 0;
      truncated = true;
    } else {
      startRow = watermark.line + 1;
    }
    const endRow = reader.length() - 1;
    // The lowest row of the bottom-most unit we own this scan — everything ABOVE it is
    // witnessed done (more content follows) and gets sealed; this unit itself stays
    // provisional unless a composer proves the turn complete. -1 ⇒ nothing detected.
    let bottomUnitStart = -1;

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

      for (const region of allRegions) {
        // Dedup at the parent level only; findings ride on the parent so identical
        // finding text across different reports never collides, and an unchanged
        // report (and its findings) is skipped wholesale on the next scan.
        const norm = normalize(region.text);
        const key = dedupKey(region.type, norm);
        const superseded = supersededBy(region.type, region.startRow, norm, key);
        if (superseded === null) continue; // already shown — drop this capture
        // Retract every partial this region completes so the pane keeps only the
        // fuller capture; happens before suppression so suppressed growth still cleans up.
        for (const c of superseded) {
          if (c.id !== undefined) deps.remove?.(c.id);
          forget(c.key);
        }
        // Echoed self-injected input: remember it so it never re-emits, but don't
        // surface it; the agent's reply renders below the watermark and still does (§16.5).
        if (deps.isSuppressed?.({ startRow: region.startRow, endRow: region.endRow })) {
          remember({ key, type: region.type, norm });
          continue;
        }
        const parentId = emit({ type: region.type, source: region.source, text: region.text, parentId: null, truncated });
        remember({ key, type: region.type, norm, id: parentId, startMarker: addMarker(region.startRow) });
        for (const child of region.children ?? []) {
          emit({ type: child.type, source: child.source, text: child.text, parentId, truncated });
        }
      }
    }

    // Advance the watermark to the stability frontier, never backward (§15.3 / v2.22).
    // On the alt buffer there is nothing to track — resume from the top when normal returns.
    const sealRow = computeSealRow(altScreen, startRow, endRow, bottomUnitStart);
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
