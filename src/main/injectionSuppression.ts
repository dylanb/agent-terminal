// Self-injection suppression (§16.5). Byte-matching can't catch the echo (long pastes
// echo as a `[Pasted text #N +k lines]` placeholder), so suppression is gated on an
// inject-time watermark plus a time window rather than on the echoed text.

import type { ShadowMarker } from './shadow';

/** Default suppression window; override via APP_SELF_INJECT_WINDOW_MS (§15.7-style). */
export const SELF_INJECT_WINDOW_MS = 30_000;

export interface InjectionSuppressor {
  /** Must be called by the inject path before the echo returns, or the echo escapes suppression (§16.5). */
  noteInjection(): void;
  isSuppressed(region: { startRow: number; endRow: number }): boolean;
  dispose(): void;
}

export interface InjectionSuppressorDeps {
  cursorRow(): number;
  /** Undefined on the alt buffer (§15.2 / D2). */
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

  // marker.line < 0 means the watermarked row trimmed out of scrollback.
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
