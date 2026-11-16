import { appendFileSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOOP_CAPABILITIES_FILENAME } from '../../src/main/loopCapabilities';
import { writeLoopCapabilities } from './loopCapabilities';

/** The repository's `loop-capabilities.yaml` as the app's reader sees it:
 *  - `valid`: accepted;
 *  - `absent`: no file;
 *  - `malformed`: a regular file that fails the shared parser;
 *  - `not-a-file`: a directory at the path, refused as unreadable even when the suite runs as root;
 *  - `symlink`: a symlink to a valid file in the same repository, refused on confinement grounds. */
export type CapabilitiesFixtureState = 'valid' | 'absent' | 'malformed' | 'not-a-file' | 'symlink';

export interface RepoConditionsFixture {
  /** Whether the repository's own `.gitignore` carries the whole-folder `.agent-terminal/` rule. */
  readonly ignored: boolean;
  readonly capabilities: CapabilitiesFixtureState;
}

/** Puts an existing repository working tree into the given setup-check conditions. Other ignore sources
 *  (`.git/info/exclude`, the user's global excludes) are the caller's, through `createGitUserHome`. */
export function writeRepoConditions(repoDir: string, conditions: RepoConditionsFixture): void {
  if (conditions.ignored) appendFileSync(join(repoDir, '.gitignore'), '.agent-terminal/\n');
  const target = join(repoDir, LOOP_CAPABILITIES_FILENAME);
  switch (conditions.capabilities) {
    case 'valid':
      writeLoopCapabilities(repoDir);
      return;
    case 'absent':
      return;
    case 'malformed':
      writeFileSync(target, 'test_globs: 42\n');
      return;
    case 'not-a-file':
      mkdirSync(target);
      return;
    case 'symlink': {
      const real = join(repoDir, 'real-capabilities');
      mkdirSync(real);
      writeLoopCapabilities(real);
      symlinkSync(join(real, LOOP_CAPABILITIES_FILENAME), target);
      return;
    }
  }
}
