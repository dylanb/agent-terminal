// §28.3 — the `commit` gate side-effect: a local `git commit` fired out-of-band on §27.9 approve,
// alongside the §27.13 `gh` side-effects. Best-effort (§27.13 / AC3): a failure never aborts the accept.

import { CommandFailure, run } from './appBootstrapCommand';
import { coreExecHardeningArgs, freshDisabledHooksDir } from './gitHardening';
import { APP_STATE_DIRS } from './appStateDirs';

/** The identity of what a commit side-effect commits (§28.3 / §6): the phase label the declaring
 *  descriptor carries — never re-derived from run-state or the branch. */
export interface AppGateCommitCtx {
  label: string;
}

export type AppGateCommitOutcome = 'committed' | 'nothing-to-commit';

/** Fire the commit for `ctx.label`. Returns the outcome; THROWS only on a genuine failure (empty label,
 *  git error) — a benign nothing-to-commit is a returned value, not a throw. */
export type RunAppGateCommitSideEffect = (
  ctx: AppGateCommitCtx,
) => Promise<AppGateCommitOutcome>;

/** The injected domain seam — a domain concept, not git mechanics (CODE-STANDARDS seam rule). */
export interface AppGateCommitOperations {
  commitWorkingTree(label: string): Promise<AppGateCommitOutcome>;
}

export function createAppGateCommit(
  git: AppGateCommitOperations,
): RunAppGateCommitSideEffect {
  return async (ctx) => {
    if (ctx.label.trim().length === 0) {
      throw new Error('refused to commit without a phase label');
    }
    return git.commitWorkingTree(ctx.label);
  };
}

// §28.3 — `git add`/`git commit` are new command forms, so gitHardening's set is re-evaluated: `-c
// commit.gpgSign=false` neutralizes gpg.program alongside the hooks/fsmonitor set. The `filter.*.clean`
// lever (a repo `.gitattributes` + config driver run by `git add`) is an accepted residual — the agent
// already runs the repo's own code in-turn, so `git add` is no new trust boundary (§28.3).
// TODO(dylanb): clean-filter neutralization (a plumbing `hash-object --no-filters` stage) is deferred.
function commitHardeningArgs(disabledHooks: string): string[] {
  return [...coreExecHardeningArgs(disabledHooks), '-c', 'commit.gpgSign=false'];
}

/** Whether the index differs from HEAD. `git diff --cached --quiet` exits 1 when there ARE staged changes
 *  and 0 when there are none (git's contract); any other failure rethrows. */
async function hasStagedChanges(repoDir: string, harden: string[]): Promise<boolean> {
  try {
    await run('git', [...harden, 'diff', '--cached', '--quiet'], repoDir, 'commit side-effect: git diff failed');
    return false;
  } catch (e) {
    if (e instanceof CommandFailure && e.exitCode === 1) return true;
    throw e;
  }
}

export function createRealAppGateCommit(
  repoDir: string,
): RunAppGateCommitSideEffect {
  const git: AppGateCommitOperations = {
    commitWorkingTree: async (label) => {
      const harden = commitHardeningArgs(freshDisabledHooksDir());
      // `git add -A` only READS `.gitignore` (never writes it — AC2) and silently skips ignored paths.
      await run('git', [...harden, 'add', '-A'], repoDir, 'commit side-effect: git add failed');
      // Unstage the app's OWN state dirs — APP_STATE_DIRS, the SAME set the clean-tree gate uses (never a
      // parallel copy) — so they never land in a phase commit (CWE-200) and never make nothing-to-commit
      // unreachable (CWE-754), independent of the operated repo's `.gitignore`. (A `:(exclude)` pathspec on
      // `git add` instead trips git's ignored-path advice with exit 1 when the dir is also gitignored — the
      // common case — so unstage-after-add is the form that works either way. `git reset` of a non-staged
      // path is a clean no-op.)
      await run('git', [...harden, 'reset', '-q', '--', ...APP_STATE_DIRS], repoDir, 'commit side-effect: git reset failed');
      if (!(await hasStagedChanges(repoDir, harden))) return 'nothing-to-commit';
      await run('git', [...harden, 'commit', '-m', label], repoDir, 'commit side-effect: git commit failed');
      return 'committed';
    },
  };
  return createAppGateCommit(git);
}
