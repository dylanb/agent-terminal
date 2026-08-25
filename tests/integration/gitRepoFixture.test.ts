import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitRepoFixture } from '../helpers/gitRepo';

// The fixture claims hermeticity, but an ambient GIT_DIR (developer shell / CI) would redirect its setup git
// commands away from the temp repo unless the environment is built the way production does (commandEnvironment).
describe('git repo fixture — hermetic against ambient GIT_* variables', () => {
  let savedGitDir: string | undefined;
  let ambientGitDir: string | undefined;
  afterEach(() => {
    if (savedGitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = savedGitDir;
    if (ambientGitDir) rmSync(ambientGitDir, { recursive: true, force: true });
  });

  it('ignores an ambient GIT_DIR that would otherwise redirect the repo away from the fixture directory', () => {
    savedGitDir = process.env.GIT_DIR;
    ambientGitDir = mkdtempSync(join(tmpdir(), 'ambient-git-dir-'));
    process.env.GIT_DIR = ambientGitDir; // a usable dir, so a leak redirects silently rather than crashing

    const repos = createGitRepoFixture();
    try {
      const dir = repos.makeGitRepo('hermetic');
      repos.writeRepoFile(dir, 'a.txt', 'a\n');
      const sha = repos.commitAll(dir, 'seed');
      expect(sha).toMatch(/^([0-9a-f]{40}|[0-9a-f]{64})$/); // SHA-1 or SHA-256 (GIT_DEFAULT_HASH) object id
      expect(existsSync(join(dir, '.git'))).toBe(true); // the repo is the fixture's own, not the ambient GIT_DIR
    } finally {
      repos.cleanup();
    }
  });
});
