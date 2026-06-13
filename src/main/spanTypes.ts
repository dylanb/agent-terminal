// Shared span-coordinate types (§15.5/§15.6). Neutral home so the adapter contract
// and the scanner depend on a coordinate record, not on the commandTracker feature
// module — keeps the dependency flowing toward a shared type (DIP).

export interface CommandSpanRange {
  startRow: number;
  endRow: number;
}
