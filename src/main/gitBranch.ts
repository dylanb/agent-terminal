// §28.5.1 — the frozen-tests baseline's slice key: the git branch the phase loops (RED/GREEN/refactor) share.
// A detached HEAD reports the literal `HEAD`; it maps to null so it can never match a recorded branch (a
// detached state cannot prove "same slice").

import { execFileSync } from 'node:child_process';
import { commandEnvironment } from './appCommand';
import { CommandFailure, run } from './appBootstrapCommand';
import { errMsg } from './errno';
import { stripDisplayControlChars } from '../shared/controlChars';

// §27.9.1 N9b.7(c) — a read abandoned mid-flight must not leave an index lock that fails the human approve's commit.
export const LOCK_FREE_GIT_READ_ENV = { GIT_OPTIONAL_LOCKS: '0' };

const branchOrNull = (abbrevRef: string): string | null => {
  const branch = abbrevRef.trim();
  return branch.length === 0 || branch === 'HEAD' ? null : branch;
};

export type GitBranchRead = { ok: true; branch: string | null } | { ok: false; detail: string };

export function currentGitBranch(repoDir: string): GitBranchRead {
  try {
    // §28.5.1 — scrub the git env (GIT_DIR/GIT_WORK_TREE/GIT_CONFIG_*) exactly as the write-side branch capture
    // does through `run` → commandEnvironment(), so this read and that write resolve the SAME repo's HEAD.
    // eslint-disable-next-line local/git-hardening -- predates the rule; existing callers stay as they are (CODE-STANDARDS.md)
    return { ok: true, branch: branchOrNull(execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoDir, encoding: 'utf8', env: commandEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] })) };
  } catch (e) {
    return { ok: false, detail: errMsg(e) };
  }
}

/** §27.9.1 N9b.5(e), N9b.7(c) — the approve-time frozen check's branch read: abortable, and bounded by the decision. */
export async function readGitBranch(repoDir: string, signal: AbortSignal): Promise<GitBranchRead> {
  try {
    // eslint-disable-next-line local/git-hardening -- predates the rule; existing callers stay as they are (CODE-STANDARDS.md)
    const out = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], repoDir, 'git rev-parse --abbrev-ref HEAD failed', { env: LOCK_FREE_GIT_READ_ENV, signal });
    return { ok: true, branch: branchOrNull(out) };
  } catch (e) {
    return { ok: false, detail: errMsg(e) };
  }
}

export async function readBranchLabel(dir: string): Promise<string | null> {
  const git = async (args: string[]): Promise<string | null> => {
    try {
      // eslint-disable-next-line local/git-hardening -- predates the rule; existing callers stay as they are (CODE-STANDARDS.md)
      return stripDisplayControlChars((await run('git', args, dir, `git ${args[0]} failed`, { env: LOCK_FREE_GIT_READ_ENV })).trim()) || null;
    } catch (error) {
      if (error instanceof CommandFailure && typeof error.exitCode === 'number') return null;
      throw error;
    }
  };
  return (await git(['symbolic-ref', '--quiet', '--short', 'HEAD'])) ?? (await git(['rev-parse', '--short', 'HEAD']));
}
