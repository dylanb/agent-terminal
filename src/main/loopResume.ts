// Auto-resume decision (§26.11 / L8). On launch (or cd into a managed repo) the orchestrator reads
// <repo>/.agent-loop/state.yaml and resumes an in-flight run at its recorded status/iteration — but
// honoring the bound LoopDef's resume_contract rather than blindly re-injecting the current step. This is
// the pure core: given the persisted status/iteration, the phase map, the `mid_iter_safe` flag, and which
// of the iteration's turn artifacts already survived on disk, it decides which turn to (re-)enter. A gate/
// terminal/error status is human-owned and never re-driven (the §24.2.3 mirror already presents it).

/** The turn-artifact presence for the current iteration — the "which turns already produced output"
 *  signal (§26.11 `required_artifacts`): `plan` = plan.md; `reviewsComplete` = every roster persona's
 *  review is present; `consolidated` = the consolidated verdict is present. */
export interface ResumeArtifacts {
  plan: boolean;
  reviewsComplete: boolean;
  consolidated: boolean;
}

export interface ResumeInputs {
  status: string;
  iteration: number;
  /** The bound LoopDef's phases (id + entry_status) — a status equal to a phase's entry_status is
   *  mid-work at that phase; any other status is a gate/terminal/error (human-owned). */
  phases: { id: string; entryStatus: string }[];
  /** resume_contract.mid_iter_safe — false rewinds to the iteration start rather than re-entering. */
  midIterSafe: boolean;
  artifacts: ResumeArtifacts;
}

/** Which turn resume re-enters (§26.11). `none` = not an in-flight mid-work status → do not re-drive.
 *  `post-consolidate` = every turn of the iteration already produced its artifact, so only the
 *  verdict-branch remains (never re-inject a completed turn). */
export type ResumeDecision =
  | { kind: 'none' }
  | { kind: 'work'; phaseId: string; iteration: number }
  | { kind: 'reviewers'; phaseId: string; iteration: number }
  | { kind: 'consolidate'; phaseId: string; iteration: number }
  | { kind: 'post-consolidate'; phaseId: string; iteration: number };

/** Decide the resume action (§26.11). Only a status that IS a phase's entry_status is mid-work and
 *  re-driven; otherwise `none`. Mid-work re-enters the earliest turn whose artifact is missing (so
 *  completed turns are never re-run), or rewinds to work when `mid_iter_safe` is false. */
export function decideResume(inputs: ResumeInputs): ResumeDecision {
  const phase = inputs.phases.find((p) => p.entryStatus === inputs.status);
  if (!phase) return { kind: 'none' };
  const at = (kind: 'work' | 'reviewers' | 'consolidate' | 'post-consolidate'): ResumeDecision => ({
    kind,
    phaseId: phase.id,
    iteration: inputs.iteration,
  });
  if (!inputs.midIterSafe) return at('work');
  const a = inputs.artifacts;
  if (!a.plan) return at('work');
  if (!a.reviewsComplete) return at('reviewers');
  if (!a.consolidated) return at('consolidate');
  return at('post-consolidate');
}
