import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGitRepoFixture, type GitRepoFixture } from '../helpers/gitRepo';
import { currentGitBranch } from '../../src/main/gitBranch';
import { installPathGitStub } from '../helpers/pathGitStub';
import { shellQuote } from '../../src/shared/shellQuote';

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

  it('reads the branch under the repo\'s own git config: no hooks-path or fsmonitor override (v2.184 (10))', () => {
    const repo = fx.makeGitRepo('gitbranch-config');
    fx.writeRepoFile(repo, 'seed.txt', 'x\n');
    fx.commitAll(repo, 'baseline');
    const expected = fx.git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const log = join(mkdtempSync(join(tmpdir(), 'gitbranch-config-log-')), 'git.log');
    const stub = installPathGitStub([{ argvPrefix: [], script: `printf '%s\\n' "$*" >> ${shellQuote(log)}` }]);
    try {
      expect(currentGitBranch(repo)).toBe(expected);
      const lines = readFileSync(log, 'utf8').split('\n').filter((l) => l.includes('rev-parse --abbrev-ref HEAD'));
      expect(lines).toHaveLength(1);
      expect(lines.filter((l) => /core\.(hooksPath|fsmonitor)=/.test(l))).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
      stub.dispose();
    }
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

  it('resolves the repoDir branch under a hostile ambient GIT_DIR (same git-env scrub as the commit-side read)', () => {
    // §28.5.1 shared-semantics: the write side records the branch through `run` → commandEnvironment() (which
    // strips GIT_DIR/GIT_WORK_TREE); this read must scrub the SAME env, else an ambient GIT_DIR resolves HEAD in
    // a different repo than the write recorded and the branch key silently desyncs. A bogus GIT_DIR that git
    // honored would abort the read to null; scrubbed, the repoDir's real branch comes back.
    const repo = fx.makeGitRepo('gitbranch-env');
    fx.writeRepoFile(repo, 'seed.txt', 'x\n');
    fx.commitAll(repo, 'baseline');
    const expected = fx.git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const bogus = mkdtempSync(join(tmpdir(), 'gitbranch-bogus-gitdir-'));
    const prior = process.env.GIT_DIR;
    process.env.GIT_DIR = bogus;
    try {
      expect(currentGitBranch(repo)).toBe(expected);
    } finally {
      if (prior === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = prior;
      rmSync(bogus, { recursive: true, force: true });
    }
  });
});
