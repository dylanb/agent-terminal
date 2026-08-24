// §28.5.1 — the frozen-tests baseline's slice key: the git branch the phase loops (RED/GREEN/refactor) share.
// A detached HEAD reports the literal `HEAD`; it maps to null so it can never match a recorded branch (a
// detached state cannot prove "same slice").

import { execFileSync } from 'node:child_process';
import { coreExecHardeningArgs, freshDisabledHooksDir } from './gitHardening';

export function currentGitBranch(repoDir: string): string | null {
  try {
    const harden = coreExecHardeningArgs(freshDisabledHooksDir());
    const branch = execFileSync('git', [...harden, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repoDir,
      encoding: 'utf8',
    }).trim();
    return branch.length === 0 || branch === 'HEAD' ? null : branch;
  } catch {
    return null;
  }
}
