// §28.3 — the `commit` gate side-effect: a local `git commit` fired out-of-band on §27.9 approve,
// alongside the §27.13 `gh` side-effects. It carries the phase label the declaring descriptor names
// (§28.3 / §6 identity), stages the working tree, and records it as one commit — best-effort, so a
// failure never aborts the terminal accept (§27.13 / AC3).

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandFailure, run } from './appBootstrapCommand';
import { coreExecHardeningArgs } from './gitHardening';

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
  return async (ctx) => {
    if (ctx.label.trim().length === 0) {
      throw new Error('refused to commit without a phase label');
    }
    return git.commitWorkingTree(ctx.label);
  };
}

// §28.5.1 precedent — `git add`/`git commit` are NEW command forms, so gitHardening's set is re-evaluated:
// gpg signing is also a local-exec lever (a planted `commit.gpgSign=true` makes `git commit` run
// `gpg.program`), so `-c commit.gpgSign=false` neutralizes it alongside the hooks/fsmonitor set. The
// `filter.*.clean` lever (a repo `.gitattributes` + config driver, run by `git add`) is a
// documented-accepted residual: the agent already runs the repo's own build/test code in-turn, so this
// `git add` is no new trust boundary — see CODE-STANDARDS / §28.3.
// TODO(dylanb): clean-filter neutralization (a plumbing `hash-object --no-filters` stage) is deferred as
// an accepted residual; revisit if the §28 threat model tightens.
function commitHardeningArgs(disabledHooks: string): string[] {
  return [...coreExecHardeningArgs(disabledHooks), '-c', 'commit.gpgSign=false'];
}

/** Whether the index differs from HEAD. `git diff --cached --quiet` exits 1 when there ARE staged
 *  changes and 0 when there are none (git's documented contract); any other failure rethrows. */
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
      // A fresh, unpredictable, never-created hooks dir: with core.hooksPath pointed here no hook can run.
      const disabledHooks = join(tmpdir(), `agent-terminal-commit-hooks-${randomUUID()}`);
      const harden = commitHardeningArgs(disabledHooks);
      // `git add -A` captures tracked mods, deletions, and new untracked files, and only READS `.gitignore`
      // (never writes it — AC2). AC1's "tree clean" and AC3's "nothing to commit" hold only because the
      // operated repo gitignores `<repo>/.agent-terminal/` (.gitignore:14): the engine's own run-/flow-state
      // writes around this side-effect (appGateDecision persistAccept/advanceFlow) would otherwise dirty the
      // tracked tree. The app must not create that ignore (no production code modifies .gitignore).
      await run('git', [...harden, 'add', '-A'], repoDir, 'commit side-effect: git add failed');
      if (!(await hasStagedChanges(repoDir, harden))) return 'nothing-to-commit';
      await run('git', [...harden, 'commit', '-m', label], repoDir, 'commit side-effect: git commit failed');
      return 'committed';
    },
  };
  return createAppGateCommit(git);
}
