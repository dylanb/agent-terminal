// Cumulative loop-iteration display (§26 D42a). A chained run passes through several loops in sequence
// (plan-loop → impl-loop → …); each loop keeps its OWN internal iteration counter, reset to 1 when the run
// is rebound to it (resume --loop). The user-visible count, however, must CLIMB across the whole run — it
// never drops back to 1 when a successor loop starts. This one definition is shared by the main-process
// mirror (which turns the raw per-loop counter into the displayed value) and the tests, so the display rule
// cannot drift (CLAUDE.md shared-semantics).

/** One prior loop a run has completed, and the internal iteration count it finished at. Serialized as a
 *  `completed_loops` entry in state.yaml; recorded when the run is rebound to a successor loop (§26 D42a). */
export interface CompletedLoop {
  loop: string;
  iterations: number;
}

/** The user-visible iteration for a chained run: every completed loop's final iteration, plus the current
 *  loop's internal iteration. Equals `current` for the first loop of a run (no completed loops yet). */
export function cumulativeIteration(completed: CompletedLoop[], current: number): number {
  return completed.reduce((sum, c) => sum + c.iterations, 0) + current;
}
