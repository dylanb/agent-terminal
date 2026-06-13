// Semantic scanner (§15.2/§15.3 / D2/D7). Runs ONLY on the active→quiet
// transition (never per chunk, never on a timer), reads the full buffer including
// scrollback via a marker watermark, dispatches to adapters, dedups by content,
// and emits widened MonitorEvents. Detection only — it never acts on an event.

import type { MonitorEventSource, MonitorEventType } from '../shared/ipc';
import type { ShadowMarker, ShadowReader } from './shadow';
import type { Adapter } from './adapters/types';
import type { CommandSpanRange } from './spanTypes';

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
  /** Specific adapters, tried in order; the first whose fingerprint matches wins. */
  adapters: Adapter[];
  /** Generic heuristic, used only when no specific adapter matches (§15.3 / D6). */
  fallback?: Adapter;
  dedupRetention: number;
  /** Minimum report size (chars) before a `report` is emitted (§15.3 / §15.7). */
  reportMinChars: number;
  emit: ScannerEmit;
  closedSpans?: () => CommandSpanRange[];
  /** Drops echoed self-injected input from emission (§16.5); omitted ⇒ no suppression. */
  isSuppressed?: (region: { startRow: number; endRow: number }) => boolean;
}

export interface Scanner {
  dispose(): void;
}

/** Coordinate-free dedup key so a region survives scrollback trim (§15.3). */
function dedupKey(type: MonitorEventType, text: string): string {
  // `::` cannot collide: MonitorEventType is a fixed kebab-case enum with no colons.
  return `${type}::${text.trim().replace(/\s+/g, ' ')}`;
}

export function createScanner(deps: ScannerDeps): Scanner {
  const { reader, addMarker, emit } = deps;
  let watermark: ShadowMarker | undefined;
  const seen = new Set<string>();
  const order: string[] = [];

  function remember(key: string) {
    seen.add(key);
    order.push(key);
    while (order.length > deps.dedupRetention) {
      const evicted = order.shift();
      if (evicted !== undefined) seen.delete(evicted);
    }
  }

  function scan() {
    const altScreen = reader.bufferType() === 'alternate';
    let startRow: number;
    let truncated = false;
    if (!watermark) {
      startRow = 0;
    } else if (watermark.line < 0) {
      // Scrollback trimmed past the watermark — re-scan from the top and stamp
      // every event from this scan truncated (conservative, scan-wide — A2).
      startRow = 0;
      truncated = true;
    } else {
      // Always re-include the viewport so in-place rewrites are re-examined; dedup
      // suppresses unchanged regions.
      startRow = Math.min(watermark.line, reader.baseY());
    }
    const endRow = reader.length() - 1;
    const closedSpans = deps.closedSpans?.() ?? [];
    const ctx = { reader, startRow, endRow, altScreen, closedSpans, reportMinChars: deps.reportMinChars };

    // Select the first specific adapter that fingerprints this buffer; degrade to
    // the generic fallback when none match, never to silence (§15.3).
    const active = deps.adapters.find((a) => (a.matches ? a.matches(ctx) : true)) ?? deps.fallback;
    for (const region of active?.detect(ctx) ?? []) {
      // Dedup at the parent level only; findings ride on the parent so identical
      // finding text across different reports never collides, and an unchanged
      // report (and its findings) is skipped wholesale on the next scan.
      const key = dedupKey(region.type, region.text);
      if (seen.has(key)) continue;
      // Echoed self-injected input: remember it so it never re-emits, but don't
      // surface it; the agent's reply renders below the watermark and still does (§16.5).
      if (deps.isSuppressed?.({ startRow: region.startRow, endRow: region.endRow })) {
        remember(key);
        continue;
      }
      remember(key);
      const parentId = emit({ type: region.type, source: region.source, text: region.text, parentId: null, truncated });
      for (const child of region.children ?? []) {
        emit({ type: child.type, source: child.source, text: child.text, parentId, truncated });
      }
    }

    watermark?.dispose();
    watermark = addMarker(endRow); // undefined on alt buffer — next scan starts at row 0
  }

  const unsub = deps.onQuiet(scan);

  return {
    dispose() {
      unsub();
      watermark?.dispose();
    },
  };
}
