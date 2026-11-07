import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A user home git reads its user-level ignore rules from, owned by one test. Its `env` sets only HOME and
 *  removes XDG_CONFIG_HOME, so git's default excludes path is `$HOME/.config/git/ignore`. The git config files
 *  (`GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM`) stay with their one vitest owner, `createGitRepoFixture`. */
export interface GitUserHome {
  readonly home: string;
  /** `undefined` means "absent": `vi.stubEnv` deletes the key, and an e2e launch drops it. */
  readonly env: Readonly<Record<'HOME' | 'XDG_CONFIG_HOME', string | undefined>>;
  /** Applies `env` through a stubbing function such as `vi.stubEnv`, whose restore the caller owns. */
  applyTo(stub: (name: string, value: string | undefined) => unknown): void;
  /** Writes git's default user-level excludes file, `$HOME/.config/git/ignore`. */
  writeDefaultExcludes(text: string): void;
  /** Writes an excludes file elsewhere in this home and returns its path, for a test to name as
   *  `core.excludesFile` (e.g. `git config --global` through `createGitRepoFixture`'s `git`). */
  writeExcludesFile(text: string): string;
  dispose(): void;
}

export function createGitUserHome(): GitUserHome {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'git-user-home-')));
  const home = join(root, 'home');
  mkdirSync(home);
  const env = { HOME: home, XDG_CONFIG_HOME: undefined };
  return {
    home,
    env,
    applyTo(stub) {
      for (const [name, value] of Object.entries(env)) stub(name, value);
    },
    writeDefaultExcludes(text) {
      const dir = join(home, '.config', 'git');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'ignore'), text);
    },
    writeExcludesFile(text) {
      const file = join(home, 'custom-excludes');
      writeFileSync(file, text);
      return file;
    },
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}
