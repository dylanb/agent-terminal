// §28.3 — the `commit` gate side-effect: a local `git commit` fired out-of-band on §27.9 approve,
// alongside the §27.13 `gh` side-effects. It carries the phase label the declaring descriptor names
// (§28.3 / §6 identity), stages the working tree, and records it as one commit — best-effort, so a
// failure never aborts the terminal accept (§27.13 / AC3).
//
// STUB (RED): the ports return a fixed outcome and do no git yet, so the RED tests fail on behavioral
// assertions (HEAD did not advance / outcome mismatch / ops not called), not a missing import.

/** The identity of what a commit side-effect commits (§28.3 / §6): the phase label the declaring
 *  descriptor carries — never re-derived from run-state or the branch. */
export interface AppGateCommitCtx {
  label: string;
}

/** The outcome the executor discriminates on: a real commit landed, or there was genuinely nothing to
 *  commit (a benign no-op, recorded distinctly — never as a failure). A real git error throws. */
export type AppGateCommitOutcome = 'committed' | 'nothing-to-commit';

/** Fire the commit for `ctx.label`. Returns which outcome happened; THROWS only on a genuine failure
 *  (empty label, git error) — surfaced by the executor's best-effort catch. */
export type RunAppGateCommitSideEffect = (
  ctx: AppGateCommitCtx,
) => Promise<AppGateCommitOutcome>;

/** The injected domain seam — a domain concept, not git mechanics (CODE-STANDARDS seam rule). */
export interface AppGateCommitOperations {
  /** Stage the working tree and record it as one commit whose subject is `label`. Returns
   *  'nothing-to-commit' (no throw) when the tracked tree had no change; throws on a git error. */
  commitWorkingTree(label: string): Promise<AppGateCommitOutcome>;
}

export function createAppGateCommit(
  git: AppGateCommitOperations,
): RunAppGateCommitSideEffect {
  void git;
  return async (_ctx) => 'committed';
}

export function createRealAppGateCommit(
  repoDir: string,
): RunAppGateCommitSideEffect {
  void repoDir;
  return async (_ctx) => 'committed';
}
