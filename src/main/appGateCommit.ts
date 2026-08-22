// §28.3/§28.5.1 — the `commit` gate side-effect: a local `git commit` fired out-of-band on §27.9 approve,
// alongside the §27.13 `gh` side-effects. Best-effort (§27.13 / AC3): a failure never aborts the accept. On a
// commit it captures the new HEAD SHA (§28.5.1) — the baseline the next phase's frozen-tests diffs from — and
// stages ONLY the phase's own paths (the injected phase-start snapshot leaves operator WIP untouched, §28.3).

import { CommandFailure, run } from './appBootstrapCommand';
import { coreExecHardeningArgs, freshDisabledHooksDir } from './gitHardening';
import { APP_STATE_DIRS } from './appStateDirs';
import { isGitObjectId } from '../shared/appBootstrap';

/** The identity of what a commit side-effect commits (§28.3 / §6): the phase label the declaring
 *  descriptor carries — never re-derived from run-state or the branch. */
export interface AppGateCommitCtx {
  label: string;
  /** §28.3 — the repo-relative paths already dirty at phase start: operator WIP the commit leaves untouched.
   *  A path listed here is unstaged wholesale, so the phase's own later change to an already-dirty file is
   *  not committed either — the operator's edits win. A domain input the phase lifecycle supplies (§28.5.1);
   *  empty leaves every changed path phase-produced. */
  dirtyAtPhaseStart: readonly string[];
}

/** The result of firing the side-effect: on `committed`, the new HEAD SHA (§28.5.1); on `nothing-to-commit`,
 *  no SHA — a discriminated union so no field one mode ignores. THROWS only on a genuine failure (empty label,
 *  git error, a commit that raced the window, or a non-object-id SHA); a benign nothing-to-commit is returned. */
export type AppGateCommitResult = { outcome: 'committed'; sha: string } | { outcome: 'nothing-to-commit' };

export type RunAppGateCommitSideEffect = (
  ctx: AppGateCommitCtx,
) => Promise<AppGateCommitResult>;

/** One commit of the working tree, reported as a domain concept: the new commit's SHA and the parent it
 *  recorded (so the composition can verify no commit raced the window — §28.5.1), or nothing to commit. */
export type AppGateCommitStep =
  | { outcome: 'committed'; sha: string; parentSha: string }
  | { outcome: 'nothing-to-commit' };

/** The injected domain seam — domain concepts, not git mechanics (CODE-STANDARDS seam rule): the current head
 *  (the baseline the commit will build on) and committing the working tree (reporting the new commit + parent),
 *  staging only the phase's own paths — `dirtyAtPhaseStart` is the operator WIP the commit must leave untouched. */
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
    // §28.5.1 — the operated repo hosts a live agent sharing the working tree. A commit that raced into the
    // window (between capturing `before` and our commit) would leave the new HEAD, and our captured SHA,
    // pointing at agent state; its parent would NOT be the head we captured. Refuse to record a poisoned
    // baseline (fail toward firing — no result; the accept surfaces the failure and stays Retry-recoverable).
    if (step.parentSha !== before) {
      throw new Error('a commit raced the phase commit — refusing to record a poisoned baseline');
    }
    // CWE-20 — a garbage SHA from git must never become a persisted baseline.
    if (!isGitObjectId(step.sha)) {
      throw new Error(`refusing a non-object-id phase-commit SHA: ${step.sha}`);
    }
    return { outcome: 'committed', sha: step.sha };
  };
}

// §28.3 — `git add`/`git commit` are new command forms, so gitHardening's set is re-evaluated: `-c
// commit.gpgSign=false` neutralizes gpg.program alongside the hooks/fsmonitor set. The `filter.*.clean` lever
// (a repo `.gitattributes` + config driver run by `git add`) is an accepted residual — the agent already runs
// the repo's own code in-turn, so `git add` is no new trust boundary (§28.3).
// TODO(dylanb): clean-filter neutralization (a plumbing `hash-object --no-filters` stage) is deferred.
function commitHardeningArgs(disabledHooks: string): string[] {
  return [...coreExecHardeningArgs(disabledHooks), '-c', 'commit.gpgSign=false'];
}

/** Whether the index differs from HEAD. `git diff --cached --quiet` exits 1 when there ARE staged changes and 0
 *  when there are none (git's contract); any other failure rethrows. */
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
  const revParse = async (rev: string, failure: string): Promise<string> => {
    const harden = commitHardeningArgs(freshDisabledHooksDir());
    return (
      await run('git', [...harden, 'rev-parse', '--verify', '--end-of-options', rev], repoDir, failure)
    ).trim();
  };
  const git: AppGateCommitOperations = {
    // Rejects on a rootless repo (no HEAD) — the §28 chain always runs post-pickup, so a missing HEAD is a
    // genuine failure, not a baseline story to invent.
    headCommit: () => revParse('HEAD', 'commit side-effect: git rev-parse HEAD failed'),
    commitWorkingTree: async (label, dirtyAtPhaseStart) => {
      const harden = commitHardeningArgs(freshDisabledHooksDir());
      // `git add -A` only READS `.gitignore` (never writes it — AC2) and silently skips ignored paths.
      await run('git', [...harden, 'add', '-A'], repoDir, 'commit side-effect: git add failed');
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
        [...harden, '--literal-pathspecs', 'reset', '-q', '--', ...dirtyAtPhaseStart, ...APP_STATE_DIRS],
        repoDir,
        'commit side-effect: git reset failed',
      );
      if (!(await hasStagedChanges(repoDir, harden))) return { outcome: 'nothing-to-commit' };
      await run('git', [...harden, 'commit', '-m', label], repoDir, 'commit side-effect: git commit failed');
      // §28.5.1 — read the new commit + its parent in-adapter, chained right after `git commit`, never deferred:
      // a deferred read could observe a commit the live agent made in the window and poison the baseline.
      const sha = await revParse('HEAD', 'commit side-effect: git rev-parse HEAD failed');
      const parentSha = await revParse('HEAD^', 'commit side-effect: git rev-parse parent failed');
      return { outcome: 'committed', sha, parentSha };
    },
  };
  return createAppGateCommit(git);
}
