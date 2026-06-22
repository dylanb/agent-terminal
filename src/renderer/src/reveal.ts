// Cross-highlight matcher (§16.8), terminal→capture direction. selection.ts must feed it the LIVE
// marker rows (xterm markers track reflow), else a resize that moved the captured rows stales the
// match.

export interface RevealSpan {
  id: string;
  start: number;
  end: number;
}

/** The most-specific (smallest-span) capture whose [start,end] covers `row`, or null. */
export function pickRevealTarget(spans: RevealSpan[], row: number): string | null {
  let bestId: string | null = null;
  let bestSpan = Infinity;
  for (const { id, start, end } of spans) {
    if (row < start || row > end) continue;
    const span = end - start;
    if (span < bestSpan) {
      bestSpan = span;
      bestId = id;
    }
  }
  return bestId;
}
