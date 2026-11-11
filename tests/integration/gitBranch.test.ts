import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGitRepoFixture, type GitRepoFixture } from '../helpers/gitRepo';
import { currentGitBranch, readBranchLabel } from '../../src/main/gitBranch';
import { errMsg } from '../../src/main/errno';
import { installPathGitStub } from '../helpers/pathGitStub';
import { shellQuote } from '../../src/shared/shellQuote';

// §28.5.1, §27.10
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
    expect(currentGitBranch(repo)).toEqual({ ok: true, branch: fx.git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']) });
  });

  it('reads the branch under the repo\'s own git config: no hooks-path or fsmonitor override', () => {
    const repo = fx.makeGitRepo('gitbranch-config');
    fx.writeRepoFile(repo, 'seed.txt', 'x\n');
    fx.commitAll(repo, 'baseline');
    const expected = fx.git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const log = join(mkdtempSync(join(tmpdir(), 'gitbranch-config-log-')), 'git.log');
    const stub = installPathGitStub([{ argvPrefix: [], script: `printf '%s\\n' "$*" >> ${shellQuote(log)}` }]);
    try {
      expect(currentGitBranch(repo)).toEqual({ ok: true, branch: expected });
      const lines = readFileSync(log, 'utf8').split('\n').filter((l) => l.includes('rev-parse --abbrev-ref HEAD'));
      expect(lines).toHaveLength(1);
      expect(lines.filter((l) => /core\.(hooksPath|fsmonitor)=/.test(l))).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
      stub.dispose();
    }
  });

  it('returns a null branch on a detached HEAD (the literal HEAD cannot key a slice)', () => {
    const repo = fx.makeGitRepo('gitbranch-detached');
    fx.writeRepoFile(repo, 'seed.txt', 'x\n');
    const sha = fx.commitAll(repo, 'baseline');
    fx.git(repo, ['checkout', '--detach', sha]);
    expect(currentGitBranch(repo)).toEqual({ ok: true, branch: null });
  });

  it('reports git\'s own reason for a non-git directory, not a detached HEAD', () => {
    const notARepo = mkdtempSync(join(tmpdir(), 'gitbranch-nonrepo-'));
    try {
      const read = currentGitBranch(notARepo);
      expect(read.ok).toBe(false);
      expect(!read.ok && read.detail).toMatch(/not a git repository/i);
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });

  it('resolves the repoDir branch under a hostile ambient GIT_DIR (same git-env scrub as the commit-side read)', () => {
    // §28.5.1 shared-semantics: the write side records the branch through `run` → commandEnvironment() (which
    // strips GIT_DIR/GIT_WORK_TREE); this read must scrub the SAME env, else an ambient GIT_DIR resolves HEAD in
    // a different repo than the write recorded and the branch key silently desyncs. A bogus GIT_DIR that git
    // honored would fail the read; scrubbed, the repoDir's real branch comes back.
    const repo = fx.makeGitRepo('gitbranch-env');
    fx.writeRepoFile(repo, 'seed.txt', 'x\n');
    fx.commitAll(repo, 'baseline');
    const expected = fx.git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const bogus = mkdtempSync(join(tmpdir(), 'gitbranch-bogus-gitdir-'));
    const prior = process.env.GIT_DIR;
    process.env.GIT_DIR = bogus;
    try {
      expect(currentGitBranch(repo)).toEqual({ ok: true, branch: expected });
    } finally {
      if (prior === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = prior;
      rmSync(bogus, { recursive: true, force: true });
    }
  });
});

describe('readBranchLabel', () => {
  let fx: GitRepoFixture;
  beforeEach(() => {
    fx = createGitRepoFixture();
  });
  afterEach(() => fx.cleanup());

  const labelOf = async (dir: string): Promise<{ label: string | null } | { threw: string }> => {
    try { return { label: await readBranchLabel(dir) }; } catch (error) { return { threw: errMsg(error) }; }
  };
  const committedRepo = (prefix: string): string => {
    const repo = fx.makeGitRepo(prefix);
    fx.writeRepoFile(repo, 'seed.txt', 'x\n');
    fx.commitAll(repo, 'baseline');
    return repo;
  };

  it('is the branch name the repository is on', async () => {
    const repo = committedRepo('label-branch');
    fx.git(repo, ['checkout', '-q', '-b', 'feature/card-identity']);
    expect(await labelOf(repo)).toEqual({ label: 'feature/card-identity' });
  });

  it('replaces bidi and other display control characters in a branch name', async () => {
    const repo = committedRepo('label-bidi');
    fx.git(repo, ['checkout', '-q', '-b', 'fix-\u202Etxt.exe']);
    expect(await labelOf(repo)).toEqual({ label: 'fix- txt.exe' });
  });

  it('follows a switch to another branch', async () => {
    const repo = committedRepo('label-switch');
    expect(await labelOf(repo)).toEqual({ label: 'main' });
    fx.git(repo, ['checkout', '-q', '-b', 'topic-two']);
    expect(await labelOf(repo)).toEqual({ label: 'topic-two' });
  });

  it('is the branch name when read from a subdirectory of the working tree', async () => {
    const repo = committedRepo('label-subdir');
    fx.git(repo, ['checkout', '-q', '-b', 'nested-read']);
    const sub = join(repo, 'src', 'deep');
    mkdirSync(sub, { recursive: true });
    expect(await labelOf(sub)).toEqual({ label: 'nested-read' });
  });

  it('is the short commit on a detached HEAD', async () => {
    const repo = committedRepo('label-detached');
    fx.writeRepoFile(repo, 'second.txt', 'y\n');
    const second = fx.commitAll(repo, 'second');
    fx.git(repo, ['checkout', '-q', '--detach', second]);
    const read = await labelOf(repo);
    expect(read).toEqual({ label: fx.git(repo, ['rev-parse', '--short', 'HEAD']) });
    expect('label' in read && read.label).toMatch(/^[0-9a-f]{7,}$/);
  });

  it('is null for a directory that is not a git repository', async () => {
    const notARepo = mkdtempSync(join(tmpdir(), 'label-nonrepo-'));
    try {
      expect(await labelOf(notARepo)).toEqual({ label: null });
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });

  it('rejects with the reason when git cannot run in the directory', async () => {
    expect(await labelOf(join(tmpdir(), 'label-missing-directory-that-does-not-exist'))).toEqual({ threw: expect.stringContaining('git symbolic-ref failed') });
  });

  it('reads the repository it is given under a hostile ambient GIT_DIR', async () => {
    const repo = committedRepo('label-env');
    fx.git(repo, ['checkout', '-q', '-b', 'own-branch']);
    const bogus = mkdtempSync(join(tmpdir(), 'label-bogus-gitdir-'));
    const prior = process.env.GIT_DIR;
    process.env.GIT_DIR = bogus;
    try {
      expect(await labelOf(repo)).toEqual({ label: 'own-branch' });
    } finally {
      if (prior === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = prior;
      rmSync(bogus, { recursive: true, force: true });
    }
  });
});
