// §28.5.1 — the frozen-tests baseline's slice key: the git branch the phase loops (RED/GREEN/refactor) share.
// A detached HEAD reports the literal `HEAD`; it maps to null so it can never match a recorded branch (a
// detached state cannot prove "same slice").

import { execFileSync } from 'node:child_process';
import { coreExecHardeningArgs, freshDisabledHooksDir } from './gitHardening';
import { commandEnvironment } from './appCommand';

export function currentGitBranch(repoDir: string): string | null {
  try {
    const harden = coreExecHardeningArgs(freshDisabledHooksDir());
    // §28.5.1 — scrub the git env (GIT_DIR/GIT_WORK_TREE/GIT_CONFIG_*) exactly as the write-side branch capture
    // does through `run` → commandEnvironment(), so this read and that write resolve the SAME repo's HEAD.
    const branch = execFileSync('git', [...harden, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repoDir,
      encoding: 'utf8',
      env: commandEnvironment(),
    }).trim();
    return branch.length === 0 || branch === 'HEAD' ? null : branch;
  } catch {
    return null;
  }
}
