// Resume-into-a-new-loop rebind (§26 D42a / L8 — `agent-loop resume --loop <new>`). Pure: the imperative
// read/write/turn wiring lives in the orchestrator (index.ts).

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
      // §26.6/§26.8 — the successor loop opens its OWN per-loop cap window: cap_baseline = the prior loop's
      // final iteration, so the first turn is internal-count 1 ((prior.iteration+1) - prior.iteration).
      capBaseline: prior.iteration,
      pr: prior.pr,
      branch: prior.branch,
      boundLoop: loopName,
      linkedIssues: prior.linkedIssues,
    },
    workPhase: phase.id,
  };
}

/** Either the rebind to drive, or the reason the step cannot be entered — stated so the caller can show it. */
export type StepResumePlan = (ResumeRebind & { ok: true }) | { ok: false; reason: string };

/** Decide what entering loop step `loopName` should do, given the run on disk (`prior`, null when there is
 *  none) and the step's parsed def (`newDef`, null when it is missing or unparseable). Entering a loop step
 *  is automatic (the gate approve advances the flow), so a refusal the human never sees would park the flow
 *  on a step with no turn to retry: every failure carries a reason instead. */
export function planStepResume(
  prior: ResumeRebindPrior | null,
  loopName: string,
  newDef: LoopDef | null,
): StepResumePlan {
  if (!newDef) return { ok: false, reason: `no loop definition found for "${loopName}"` };
  if (!prior) return { ok: false, reason: `no agent-loop run to resume under "${loopName}"` };
  const rebind = resumeRebindWrite(prior, loopName, newDef);
  if (!rebind) return { ok: false, reason: `loop "${loopName}" declares no phase to run` };
  return { ok: true, ...rebind };
}
