import { vi } from 'vitest';
import { delimiter } from 'node:path';
import { writeGitStubBin, type GitInterception, type GitStubBin } from './gitStubBin';

export type { GitInterception } from './gitStubBin';

export type PathGitStub = GitStubBin;

/** Installs a `git` stub first on `process.env.PATH` (via `vi.stubEnv`), so any code that spawns `git` through
 *  PATH at call time reaches it. Pair `dispose()` with `vi.unstubAllEnvs()` in the caller's `afterEach`. */
export function installPathGitStub(interceptions: readonly GitInterception[]): PathGitStub {
  const stub = writeGitStubBin(interceptions);
  vi.stubEnv('PATH', `${stub.binDir}${delimiter}${process.env.PATH ?? ''}`);
  return stub;
}
