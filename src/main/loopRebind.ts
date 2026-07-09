// Resume-into-a-new-loop rebind (§26 D42a / L8 — `agent-loop resume --loop <new>`). When a flow advances
// INTO a loop step that does not bootstrap a fresh run, the existing run is rebound to the step's loop def:
// it keeps working the same PR (pr/branch/linked_issues carried) but starts the new loop FRESH — at the new
// loop's first-phase entry status, with the prior loop's internal counters reset (via the freshExtension
// write). The one thing that does NOT reset is `iteration`: it is a single MONOTONIC counter across every
// loop the run passes through (ai-deque parity), so it carries forward (+1) — this is what keeps each loop's
// reviews/<iter>/ from colliding with a predecessor's and makes the displayed count the run's running total.
// Pure: the imperative read/write/turn wiring lives in the orchestrator (index.ts).

import type { LoopDef } from './loopDef';
import type { LoopStateWrite } from './loopStateWriter';

/** The carried identity of the run being rebound — everything the new loop must keep so it continues on the
 *  same PR (§26 D42a). The internal per-loop counters are intentionally NOT carried (the new loop resets
 *  them via freshExtension); `iteration` IS carried forward monotonically (the run's running total). */
export interface ResumeRebindPrior {
  pr: number | null;
  branch: string | null;
  linkedIssues: number[];
  /** The run's iteration the prior loop finished at — the successor loop continues from here (+1). */
  iteration: number;
}

/** The rebind result: the fresh state write to persist and the work phase to drive the first turn at. */
export interface ResumeRebind {
  write: LoopStateWrite;
  workPhase: string;
}

/** Compute the rebind of an existing run to `loopName` (`newDef`). Enters the new loop's FIRST phase at its
 *  entry status, carrying the run identity and the monotonically-advanced iteration; null when the def
 *  declares no phase to drive. */
export function resumeRebindWrite(prior: ResumeRebindPrior, loopName: string, newDef: LoopDef): ResumeRebind | null {
  const phase = newDef.phases[0];
  if (!phase) return null;
  return {
    write: {
      freshExtension: true,
      status: phase.entryStatus,
      // §26 D42a — monotonic across the whole run: the successor loop's first turn is the next iteration, so
      // its reviews/<iter>/ never overwrite the prior loop's and the user-visible count keeps climbing.
      iteration: prior.iteration + 1,
      pr: prior.pr,
      branch: prior.branch,
      boundLoop: loopName,
      linkedIssues: prior.linkedIssues,
    },
    workPhase: phase.id,
  };
}
