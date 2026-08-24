import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGitRepoFixture, type GitRepoFixture } from '../helpers/gitRepo';
import { currentGitBranch } from '../../src/main/gitBranch';

// §28.5.1 — currentGitBranch is the frozen baseline's slice key. A named branch → its name; a detached HEAD or
// a non-repo → null (a state that cannot prove "same slice", so the frozen check blocks — fail toward firing).
describe('currentGitBranch (§28.5.1)', () => {
  let fx: GitRepoFixture;
  beforeEach(() => {
    fx = createGitRepoFixture();
  });
  afterEach(() => fx.cleanup());

  it('returns the current branch name for a repo on a branch', () => {
    const repo = fx.makeGitRepo('gitbranch');
    fx.writeRepoFile(repo, 'seed.txt', 'x\n');
    fx.commitAll(repo, 'baseline');
    expect(currentGitBranch(repo)).toBe(fx.git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']));
  });

  it('returns null on a detached HEAD (the literal HEAD cannot key a slice)', () => {
    const repo = fx.makeGitRepo('gitbranch-detached');
    fx.writeRepoFile(repo, 'seed.txt', 'x\n');
    const sha = fx.commitAll(repo, 'baseline');
    fx.git(repo, ['checkout', '--detach', sha]);
    expect(currentGitBranch(repo)).toBeNull();
  });

  it('returns null for a non-git directory (any git error → null → block)', () => {
    const notARepo = mkdtempSync(join(tmpdir(), 'gitbranch-nonrepo-'));
    try {
      expect(currentGitBranch(notARepo)).toBeNull();
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });
});
