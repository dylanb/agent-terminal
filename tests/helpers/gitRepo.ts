// Deterministic real-git fixtures for the frozen-tests detection tests (§28.5.1). No mock git (CLAUDE.md):
// the detection is exercised against real temporary repositories. Hermetic by construction —
//   • GIT_CONFIG_GLOBAL/SYSTEM are redirected to an empty file so a developer's ~/.gitconfig cannot change
//     a diff's result. `commandEnvironment()` (src/main/appCommand.ts) does NOT strip these two, so the
//     redirection reaches the production `run` path the detection uses, not just this helper's own commits.
//   • commit author/committer dates are pinned, so nothing depends on the wall clock.
// Each fixture owns its temp dirs and restores the env on cleanup; construct one per test.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const FIXED_DATE = '2020-01-01T00:00:00 +0000';

export interface GitRepoFixture {
  /** Create an initialised repo (branch `main`, a local identity) and return its working-tree dir. */
  makeGitRepo(prefix: string): string;
  /** Write `contents` to `relPath` under `dir`, creating parent directories. */
  writeRepoFile(dir: string, relPath: string, contents: string): void;
  /** Delete `relPath` under `dir` (no error if absent). */
  removeRepoFile(dir: string, relPath: string): void;
  /** Stage everything and commit; returns the new commit's full object id. */
  commitAll(dir: string, message: string): string;
  /** Run a raw git command in this fixture's hermetic env (redirected config, fixed dates); returns trimmed
   *  stdout. For adversarial setups the higher-level helpers don't model — a planted `refs/replace/*`, a
   *  gitlink via `update-index --cacheinfo`, a hostile repo-local `diff.*` config. */
  git(dir: string, args: string[]): string;
  /** Restore the git-config env and remove every temp dir this fixture created. */
  cleanup(): void;
}

export function createGitRepoFixture(): GitRepoFixture {
  const tracked: string[] = [];
  const savedGlobal = process.env.GIT_CONFIG_GLOBAL;
  const savedSystem = process.env.GIT_CONFIG_SYSTEM;

  const configDir = mkdtempSync(join(tmpdir(), 'git-config-'));
  tracked.push(configDir);
  const emptyConfig = join(configDir, 'config');
  writeFileSync(emptyConfig, '');
  process.env.GIT_CONFIG_GLOBAL = emptyConfig;
  process.env.GIT_CONFIG_SYSTEM = emptyConfig;

  const git = (dir: string, args: string[]): string =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_DATE: FIXED_DATE, GIT_COMMITTER_DATE: FIXED_DATE },
    }).trim();

  return {
    makeGitRepo(prefix) {
      const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
      tracked.push(dir);
      git(dir, ['init', '-q', '-b', 'main']);
      git(dir, ['config', 'user.email', 'agent@test.invalid']);
      git(dir, ['config', 'user.name', 'Agent Test']);
      return dir;
    },
    writeRepoFile(dir, relPath, contents) {
      const abs = join(dir, relPath);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, contents);
    },
    removeRepoFile(dir, relPath) {
      rmSync(join(dir, relPath), { force: true });
    },
    commitAll(dir, message) {
      git(dir, ['add', '-A']);
      git(dir, ['commit', '-q', '-m', message]);
      return git(dir, ['rev-parse', 'HEAD']);
    },
    git(dir, args) {
      return git(dir, args);
    },
    cleanup() {
      if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
      if (savedSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM;
      else process.env.GIT_CONFIG_SYSTEM = savedSystem;
      while (tracked.length) rmSync(tracked.pop()!, { recursive: true, force: true });
    },
  };
}
