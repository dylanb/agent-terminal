// §28.5.1 — the frozen-tests baseline's slice key: the git branch the phase loops (RED/GREEN/refactor) share.
// A detached HEAD reports the literal `HEAD`; it maps to null so it can never match a recorded branch (a
// detached state cannot prove "same slice").

import { execFileSync } from 'node:child_process';
import { commandEnvironment } from './appCommand';
import { run } from './appBootstrapCommand';
import { errMsg } from './errno';

// §27.9.1 N9b.7(c) — a read abandoned mid-flight must not leave an index lock that fails the human approve's commit.
export const LOCK_FREE_GIT_READ_ENV = { GIT_OPTIONAL_LOCKS: '0' };

const branchOrNull = (abbrevRef: string): string | null => {
  const branch = abbrevRef.trim();
  return branch.length === 0 || branch === 'HEAD' ? null : branch;
};

export function currentGitBranch(repoDir: string): string | null {
  try {
    // §28.5.1 — scrub the git env (GIT_DIR/GIT_WORK_TREE/GIT_CONFIG_*) exactly as the write-side branch capture
    // does through `run` → commandEnvironment(), so this read and that write resolve the SAME repo's HEAD.
    return branchOrNull(execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoDir, encoding: 'utf8', env: commandEnvironment() }));
  } catch {
    return null;
  }
}

/** §27.9.1 N9b.5(e), N9b.7(c) — the approve-time frozen check's branch read: abortable, and bounded by the decision. */
export async function readGitBranch(repoDir: string, signal: AbortSignal): Promise<{ ok: true; branch: string | null } | { ok: false; detail: string }> {
  try {
    const out = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], repoDir, 'git rev-parse --abbrev-ref HEAD failed', { env: LOCK_FREE_GIT_READ_ENV, signal });
    return { ok: true, branch: branchOrNull(out) };
  } catch (e) {
    return { ok: false, detail: errMsg(e) };
  }
}
