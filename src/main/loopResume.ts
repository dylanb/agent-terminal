// Auto-resume decision (§26.11 / L8) — the pure core. A gate/terminal/error status is human-owned and
// never re-driven (the §24.2.3 mirror presents it); a mid-work status re-enters the earliest turn whose
// iteration-scoped artifact is missing, honoring the resume_contract `mid_iter_safe` flag.

/** §26.11 / §16.3 — whether `repoDir`'s run may be auto-resumed now. `turnInFlight` must report whether a
 *  turn is actually being driven, not whether one ever was: a slot that outlives its turn turns this into a
 *  permanent veto. `resumed` records the repos already resumed this session (at most once each). This gates
 *  the DRIVING resume (it injects a turn), so it stays one-shot per repo. */
export function canResumeRepo(repoDir: string, resumed: ReadonlySet<string>, turnInFlight: boolean): boolean {
  return !resumed.has(repoDir) && !turnInFlight;
}

/** §26.3/D48 / §16.3 — whether to (re)build the reconstructed `error` turn for `repoDir`. Unlike the
 *  driving resume this injects NOTHING — it only re-establishes which turn the panel's Retry / mark-complete
 *  act on — so it is NOT one-shot: whenever the operator returns to an error-stranded repo and no turn is in
 *  flight, its recovery affordances must point at ITS turn, not one left over from a detour to another repo.
 *  `activeTurnRepo` is the repo the single turn slot currently describes (null when empty). */
export function shouldReconstructErrorTurn(
  repoDir: string,
  activeTurnRepo: string | null,
  turnInFlight: boolean,
): boolean {
  return !turnInFlight && activeTurnRepo !== repoDir;
}

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

/** The turn kind a run is currently at, from the iteration-scoped artifacts alone — the EARLIEST turn whose
 *  artifact is missing (so completed turns are never re-run), or `work` when `mid_iter_safe` is false
 *  (rewind to the iteration start). plan.md is deliberately NOT an artifact here, so a work turn that wrote
 *  plan.md but errored still maps to `work`. Shared by `decideResume` (mid-work auto-resume) and the
 *  §26.3/D48 error-recovery reconstruction (which turn a run stopped at), so the two cannot disagree. */
export function currentTurnByArtifacts(
  midIterSafe: boolean,
  artifacts: ResumeArtifacts,
): 'work' | 'reviewers' | 'consolidate' | 'post-consolidate' {
  if (!midIterSafe) return 'work';
  const workDone = artifacts.reviewsStarted || artifacts.reviewsComplete || artifacts.consolidated;
  if (!workDone) return 'work';
  if (!artifacts.reviewsComplete) return 'reviewers';
  if (!artifacts.consolidated) return 'consolidate';
  return 'post-consolidate';
}

/** Decide the resume action (§26.11). Only a status that IS a phase's entry_status is mid-work and
 *  re-driven; otherwise `none`. Mid-work re-enters the earliest turn whose artifact is missing (so
 *  completed turns are never re-run), or rewinds to work when `mid_iter_safe` is false. */
export function decideResume(inputs: ResumeInputs): ResumeDecision {
  const phase = inputs.phases.find((p) => p.entryStatus === inputs.status);
  if (!phase) return { kind: 'none' };
  return { kind: currentTurnByArtifacts(inputs.midIterSafe, inputs.artifacts), phaseId: phase.id, iteration: inputs.iteration };
}
