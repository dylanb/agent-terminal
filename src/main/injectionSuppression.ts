// Self-injection suppression (§16.5). Both inject paths (§7.5 renderer, §9.3 main)
// echo their text back into the session; the scanner must not re-capture that
// echoed input as a report/finding. Byte-matching can't catch it (long pastes echo
// as a `[Pasted text #N +k lines]` placeholder), so emission is gated on an
// injection signal instead: a watermark at the inject-time cursor row (where the
// echo renders) plus a short time window. The agent's *reply* renders below the
// echo, so its region does not contain the watermark and is still emitted.

import type { ShadowMarker } from './shadow';

/** Default suppression window; override via APP_SELF_INJECT_WINDOW_MS (§15.7-style). */
export const SELF_INJECT_WINDOW_MS = 30_000;

export interface InjectionSuppressor {
  /** Seed a watermark at the current cursor row. Called by the inject path at paste time, before the echo returns (§16.5). */
  noteInjection(): void;
  /** True iff the region contains a live, unexpired injection watermark (the echoed input). */
  isSuppressed(region: { startRow: number; endRow: number }): boolean;
  dispose(): void;
}

export interface InjectionSuppressorDeps {
  /** Absolute buffer row of the cursor right now (reader.cursor().y). */
  cursorRow(): number;
  /** Place a watermark at an absolute row; undefined on the alt buffer (§15.2 / D2). */
  addMarker(absRow: number): ShadowMarker | undefined;
  now?(): number;
  windowMs?: number;
}

export function createInjectionSuppressor(deps: InjectionSuppressorDeps): InjectionSuppressor {
  const now = deps.now ?? Date.now;
  const windowMs = deps.windowMs ?? SELF_INJECT_WINDOW_MS;
  const marks: { marker: ShadowMarker; at: number }[] = [];

  function retire(i: number) {
    marks[i].marker.dispose();
    marks.splice(i, 1);
  }

  // Drop watermarks that have expired or whose row trimmed out of scrollback (line < 0).
  function prune() {
    const cutoff = now() - windowMs;
    for (let i = marks.length - 1; i >= 0; i--) {
      if (marks[i].marker.line < 0 || marks[i].at < cutoff) retire(i);
    }
  }

  return {
    noteInjection() {
      const marker = deps.addMarker(deps.cursorRow());
      if (marker) marks.push({ marker, at: now() });
    },
    isSuppressed(region) {
      prune();
      return marks.some((m) => m.marker.line >= region.startRow && m.marker.line <= region.endRow);
    },
    dispose() {
      for (const m of marks) m.marker.dispose();
      marks.length = 0;
    },
  };
}
