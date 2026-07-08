// Resume-into-a-new-loop rebind (§26 D42a / L8 — `agent-loop resume --loop <new>`). When a flow advances
// INTO a loop step that does not bootstrap a fresh run, the existing run is rebound to the step's loop def:
// it keeps working the same PR (pr/branch/linked_issues carried) but starts the new loop FRESH — at the new
// loop's first-phase entry status, iteration 1, with the prior loop's internal counters reset (via the
// freshExtension write). Pure: the imperative read/write/turn wiring lives in the orchestrator (index.ts).

import type { LoopDef } from './loopDef';
import type { LoopStateWrite } from './loopStateWriter';
import type { CompletedLoop } from '../shared/loopIteration';

/** The carried identity of the run being rebound — everything the new loop must keep so it continues on the
 *  same PR (§26 D42a). The internal counters are intentionally NOT carried (the new loop resets them),
 *  except that the loop being LEFT (`boundLoop` at `iteration`) is recorded into the completed chain so the
 *  displayed iteration stays cumulative. */
export interface ResumeRebindPrior {
  pr: number | null;
  branch: string | null;
  linkedIssues: number[];
  /** The internal iteration the loop being left finished at — recorded into the completed chain. */
  iteration: number;
  /** The loop being left (state.yaml `bound_loop`); "" when the prior run had none (nothing to record). */
  boundLoop: string;
  /** The chain of loops already completed before this rebind — the new entry is appended to it. */
  completedLoops: CompletedLoop[];
}

/** The rebind result: the fresh state write to persist and the work phase to drive the first turn at. */
export interface ResumeRebind {
  write: LoopStateWrite;
  workPhase: string;
}

/** Compute the rebind of an existing run to `loopName` (`newDef`). Enters the new loop's FIRST phase at its
 *  entry status, iteration 1, carrying the run identity; null when the def declares no phase to drive. */
export function resumeRebindWrite(prior: ResumeRebindPrior, loopName: string, newDef: LoopDef): ResumeRebind | null {
  const phase = newDef.phases[0];
  if (!phase) return null;
  // Record the loop being left into the completed chain (name + the iteration it finished at) so the
  // displayed iteration climbs cumulatively; a run with no prior bound loop records nothing.
  const completedLoops = prior.boundLoop
    ? [...prior.completedLoops, { loop: prior.boundLoop, iterations: prior.iteration }]
    : prior.completedLoops;
  return {
    write: {
      freshExtension: true,
      status: phase.entryStatus,
      iteration: 1,
      pr: prior.pr,
      branch: prior.branch,
      boundLoop: loopName,
      linkedIssues: prior.linkedIssues,
      completedLoops,
    },
    workPhase: phase.id,
  };
}
