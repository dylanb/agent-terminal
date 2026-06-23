// Shared span-coordinate types (§15.5/§15.6). Neutral home so the adapter contract and
// the scanner depend on this, not on the commandTracker feature module (DIP).

export interface CommandSpanRange {
  startRow: number;
  endRow: number;
}
