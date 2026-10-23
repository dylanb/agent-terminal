// §28.3/§28.5.1 — the `commit` gate side-effect: a local `git commit` fired out-of-band on §27.9 approve,
// alongside the §27.13 `gh` side-effects (§27.13 decides whether its failure holds the gate). On a
// commit it captures the new HEAD SHA (§28.5.1) — the baseline the next phase's frozen-tests diffs from — and
// stages ONLY the phase's own paths (the injected phase-start snapshot leaves operator WIP untouched, §28.3).

import { CommandFailure, run } from './appBootstrapCommand';
import { APP_STATE_DIRS } from './appStateDirs';
import { isGitObjectId } from '../shared/appBootstrap';

/** The identity of what a commit side-effect commits (§28.3 / §6): the phase label the declaring
 *  descriptor carries — never re-derived from run-state or the branch. */
export interface AppGateCommitCtx {
  label: string;
  /** §28.3 — repo-relative paths already dirty at phase start (the operator's WIP): the commit leaves them
   *  untouched, wholesale — a phase edit to an already-dirty file loses to the operator's copy by design. A
   *  domain input the phase lifecycle supplies (§28.5.1); empty leaves every changed path phase-produced. */
  dirtyAtPhaseStart: readonly string[];
}

/** The result of firing the side-effect: on `committed`, the new HEAD SHA and the BRANCH it landed on (the
 *  §28.5.1 baseline key the next phase's frozen check matches); on `nothing-to-commit`, neither — a
 *  discriminated union so no field one mode ignores. */
export type AppGateCommitResult = { outcome: 'committed'; sha: string; branch: string } | { outcome: 'nothing-to-commit' };

/** Fire the commit for the descriptor's label. THROWS only on a genuine failure (empty label, git error, a
 *  commit whose parent is not the pre-commit head, or a non-object-id SHA); a benign nothing-to-commit is a
 *  returned value, not a throw. */
export type RunAppGateCommitSideEffect = (
  ctx: AppGateCommitCtx,
) => Promise<AppGateCommitResult>;

/** One commit of the working tree, reported as a domain concept: the new commit's SHA, the parent it recorded
 *  (so the composition can verify no commit raced the window — §28.5.1), and the branch it landed on (the
 *  §28.5.1 baseline key, captured in the same post-commit window as the SHA), or nothing to commit. */
export type AppGateCommitStep =
  | { outcome: 'committed'; sha: string; parentSha: string; branch: string }
  | { outcome: 'nothing-to-commit' };

/** The injected domain seam — domain concepts, not git mechanics (CODE-STANDARDS seam rule): the current head
 *  (the baseline the commit will build on) and committing the working tree (reporting the new commit, its parent,
 *  and the branch it landed on), staging only the phase's own paths — `dirtyAtPhaseStart` is the operator WIP the
 *  commit must leave untouched. */
export interface AppGateCommitOperations {
  headCommit(): Promise<string>;
  commitWorkingTree(label: string, dirtyAtPhaseStart: readonly string[]): Promise<AppGateCommitStep>;
}

export function createAppGateCommit(
  git: AppGateCommitOperations,
): RunAppGateCommitSideEffect {
  return async (ctx) => {
    if (ctx.label.trim().length === 0) {
      throw new Error('refused to commit without a phase label');
    }
    const before = await git.headCommit();
    const step = await git.commitWorkingTree(ctx.label, ctx.dirtyAtPhaseStart);
    if (step.outcome === 'nothing-to-commit') return { outcome: 'nothing-to-commit' };
    // §28.5.1 — the operated repo hosts a live agent sharing the working tree. This catches a PARENT-LINKAGE
    // race (an agent commit that moved HEAD off `before` before ours, or one stacked after ours): the new
    // commit's parent is then not the head we captured. A passing check proves only that HEAD is a commit
    // parented on `before` — NOT that its tree is ours; content poisoning that preserves the parent (a `reset`
    // to `before` then commit, or `--amend`) is left to the human gate + frozen-tests detect-and-escalate
    // backstop (§28.5.1). Refuse toward firing — no poisoned baseline persists; the failure is surfaced +
    // audited (recovery is a phase re-run, not a gate retry of this commit).
    if (step.parentSha !== before) {
      throw new Error('the phase commit is not parented on the pre-commit head — refusing a poisoned baseline');
    }
    // CWE-20 — a garbage SHA from git must never become a persisted baseline.
    if (!isGitObjectId(step.sha)) {
      throw new Error(`refusing a non-object-id phase-commit SHA: ${step.sha}`);
    }
    // §28.5.1 — the branch is captured in the SAME tight post-commit window as the SHA (inside commitWorkingTree,
    // right after the commit), never re-derived from a later read: the operated repo hosts a live agent, so a
    // deferred read could observe a checkout it made in the window. The gap between the SHA and branch reads is
    // not fully closable (two git processes), but a raced checkout there is caught by the frozen check's
    // branch-match (a mismatch blocks — fail toward firing), not silently trusted.
    return { outcome: 'committed', sha: step.sha, branch: step.branch };
  };
}

/** Whether the index differs from HEAD. `git diff --cached --quiet` exits 1 when there ARE staged changes and 0
 *  when there are none (git's contract); any other failure rethrows. */
async function hasStagedChanges(repoDir: string): Promise<boolean> {
  try {
    await run('git', ['diff', '--cached', '--quiet'], repoDir, 'commit side-effect: git diff failed');
    return false;
  } catch (e) {
    if (e instanceof CommandFailure && e.exitCode === 1) return true;
    throw e;
  }
}

export function createRealAppGateCommit(
  repoDir: string,
): RunAppGateCommitSideEffect {
  const readRev = async (args: string[], failure: string): Promise<string> => (await run('git', args, repoDir, failure)).trim();
  const git: AppGateCommitOperations = {
    // Rejects on a rootless repo (no HEAD) — the §28 chain always runs post-pickup, so a missing HEAD is a
    // genuine failure, not a baseline story to invent.
    headCommit: () => readRev(['rev-parse', '--verify', '--end-of-options', 'HEAD'], 'commit side-effect: git rev-parse HEAD failed'),
    commitWorkingTree: async (label, dirtyAtPhaseStart) => {
      // `git add -A` only READS `.gitignore` (never writes it — AC2) and silently skips ignored paths.
      await run('git', ['add', '-A'], repoDir, 'commit side-effect: git add failed');
      // Unstage what a phase commit must never sweep (§28.3): operator WIP already dirty at phase start, and
      // the app's OWN state dirs — APP_STATE_DIRS, the SAME set the clean-tree gate uses (never a parallel
      // copy) — so loop/flow state never lands in a phase commit (CWE-200) and never makes nothing-to-commit
      // unreachable (CWE-754), independent of the operated repo's `.gitignore`. The snapshot paths are
      // untrusted (a git-status listing of the operated repo), so all three ways a filename could be read as
      // something other than a literal path are closed: `--literal-pathspecs` a leading-`:` magic pathspec,
      // `--` a leading-`-` option, separate argv (execFile, no shell) a metachar — CWE-88/CWE-78. `git reset`
      // of a non-staged path is a clean no-op.
      await run(
        'git',
        ['--literal-pathspecs', 'reset', '-q', '--', ...dirtyAtPhaseStart, ...APP_STATE_DIRS],
        repoDir,
        'commit side-effect: git reset failed',
      );
      if (!(await hasStagedChanges(repoDir))) return { outcome: 'nothing-to-commit' };
      await run('git', ['commit', '-m', label], repoDir, 'commit side-effect: git commit failed');
      // §28.5.1 — read the new commit AND its parent from ONE snapshot (`rev-list --parents -n 1`), chained
      // right after `git commit`: an atomic pair, so the composition's parent-vs-`before` check compares a
      // single HEAD state (a separate `rev-parse HEAD` then `HEAD^` would straddle two snapshots — a raced
      // commit between them would spuriously reject a correct commit). Never deferred to a later turn.
      const parts = (
        await readRev(['rev-list', '--parents', '-n', '1', '--end-of-options', 'HEAD'], 'commit side-effect: git rev-list failed')
      ).split(' ');
      const sha = parts[0];
      const parentSha = parts[1];
      // A phase commit always has a parent (headCommit succeeded, so a prior commit exists); a parentless result
      // is a genuine anomaly, refused rather than returned as an unverifiable baseline.
      if (parentSha === undefined) throw new Error('commit side-effect: the phase commit has no parent');
      // §28.5.1 — the branch the commit landed on (the baseline key), read in the SAME tight post-commit window
      // as the SHA/parent, so it reflects this commit's branch rather than a later checkout the live agent made.
      const branch = await readRev(['rev-parse', '--abbrev-ref', 'HEAD'], 'commit side-effect: git rev-parse --abbrev-ref HEAD failed');
      return { outcome: 'committed', sha, parentSha, branch };
    },
  };
  return createAppGateCommit(git);
}
