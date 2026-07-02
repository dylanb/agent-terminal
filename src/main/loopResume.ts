// Auto-resume decision (§26.11 / L8) — the pure core. A gate/terminal/error status is human-owned and
// never re-driven (the §24.2.3 mirror presents it); a mid-work status re-enters the earliest turn whose
// iteration-scoped artifact is missing, honoring the resume_contract `mid_iter_safe` flag.

/** The iteration-scoped turn-artifact presence for the current iteration (§26.11 `required_artifacts`).
 *  All three are keyed to the current iteration so a stale prior-iteration file cannot masquerade as this
 *  iteration's output: `reviewsStarted` = ≥1 roster review for this iteration is present; `reviewsComplete`
 *  = every roster review is present; `consolidated` = the consolidated verdict is present. plan.md is
 *  deliberately NOT an input — it is a single file rewritten in place, so its bare presence is not
 *  iteration-scoped proof that this iteration's work turn ran. */
export interface ResumeArtifacts {
  reviewsStarted: boolean;
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
  // Work-completion for THIS iteration is proven only by an iteration-scoped downstream artifact; with
  // none, re-enter work (regenerating plan.md) rather than grading a possibly-stale prior-iteration plan.
  const workDone = a.reviewsStarted || a.reviewsComplete || a.consolidated;
  if (!workDone) return at('work');
  if (!a.reviewsComplete) return at('reviewers');
  if (!a.consolidated) return at('consolidate');
  return at('post-consolidate');
}
