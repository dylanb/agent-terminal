import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { workingTreeTestPaths, workingTreeTestPathsFromCapabilities } from '../../src/main/frozenTests';
import { createGitRepoFixture, type GitRepoFixture } from '../helpers/gitRepo';
import { writeLoopCapabilities } from '../helpers/loopCapabilities';

// §28.5.2a — the RED "a test file was added this turn" check: the WORKING TREE vs HEAD (incl. untracked), so a
// brand-new test file counts. Distinct from changedTestPaths (commit↔commit). Real temporary repos, no mock git.
describe('workingTreeTestPaths (§28.5.2a)', () => {
  let repos: GitRepoFixture;
  const TEST_GLOBS = ['tests/**'];

  beforeEach(() => {
    repos = createGitRepoFixture();
  });
  afterEach(() => repos.cleanup());

  /** A repo with an initial commit (so HEAD exists) and a clean working tree. */
  function committed(): string {
    const dir = repos.makeGitRepo('worktree-tests');
    repos.writeRepoFile(dir, 'src/a.ts', 's\n');
    repos.commitAll(dir, 'seed');
    return dir;
  }

  // IT-WORKTREE-1
  it('returns an untracked test file added to the working tree (the common RED case)', async () => {
    const dir = committed();
    repos.writeRepoFile(dir, 'tests/new.test.ts', 't\n'); // untracked, uncommitted
    await expect(workingTreeTestPaths({ repoDir: dir, testGlobs: TEST_GLOBS })).resolves.toEqual(['tests/new.test.ts']);
  });

  // IT-WORKTREE-2
  it('returns a tracked test file modified in the working tree', async () => {
    const dir = repos.makeGitRepo('worktree-tests');
    repos.writeRepoFile(dir, 'tests/a.test.ts', 'a\n');
    repos.commitAll(dir, 'seed with test');
    repos.writeRepoFile(dir, 'tests/a.test.ts', 'a2\n'); // modified, uncommitted
    await expect(workingTreeTestPaths({ repoDir: dir, testGlobs: TEST_GLOBS })).resolves.toEqual(['tests/a.test.ts']);
  });

  // IT-WORKTREE-3
  it('returns [] when only non-test files changed (the "you did not write a test" case)', async () => {
    const dir = committed();
    repos.writeRepoFile(dir, 'src/a.ts', 's2\n'); // modified source
    repos.writeRepoFile(dir, 'src/new.ts', 'n\n'); // new untracked source
    await expect(workingTreeTestPaths({ repoDir: dir, testGlobs: TEST_GLOBS })).resolves.toEqual([]);
  });

  // IT-WORKTREE-4
  it('returns [] when the working tree is clean', async () => {
    const dir = committed();
    await expect(workingTreeTestPaths({ repoDir: dir, testGlobs: TEST_GLOBS })).resolves.toEqual([]);
  });

  // IT-WORKTREE-5 — the app's own state dirs are NEVER a test path, even under a glob that would match them,
  // independent of whether the repo gitignores them (CWE-200/754: the loop writes its state every turn, so
  // counting it would make "a test file was added" trivially and spuriously true).
  it('never counts the app state dirs as a test path even under a matching glob', async () => {
    const dir = committed();
    repos.writeRepoFile(dir, '.agent-terminal/loop/run-state.yaml', 'x\n'); // the loop's own state, untracked
    repos.writeRepoFile(dir, '.agent-loop/pr-context.md', 'x\n');
    repos.writeRepoFile(dir, 'tests/real.test.ts', 't\n'); // a genuine test
    // a broad glob that WOULD match the app dirs — they must still be excluded, only the real test returned:
    await expect(workingTreeTestPaths({ repoDir: dir, testGlobs: ['**'] })).resolves.toEqual(['tests/real.test.ts']);
  });

  // IT-WORKTREE-6
  it('returns only paths matching testGlobs, and rejects an empty testGlobs (fail toward firing)', async () => {
    const dir = committed();
    repos.writeRepoFile(dir, 'tests/x.test.ts', 't\n');
    repos.writeRepoFile(dir, 'docs/y.md', 'd\n');
    await expect(workingTreeTestPaths({ repoDir: dir, testGlobs: ['tests/**'] })).resolves.toEqual(['tests/x.test.ts']);
    await expect(workingTreeTestPaths({ repoDir: dir, testGlobs: [] })).rejects.toThrow();
  });

  // IT-WORKTREE-7 — non-ASCII name (the -z raw-output contract)
  it('detects a test file with a non-ASCII name (the -z contract)', async () => {
    const dir = committed();
    repos.writeRepoFile(dir, 'tests/café-ünïcode.test.ts', 'u\n');
    await expect(workingTreeTestPaths({ repoDir: dir, testGlobs: TEST_GLOBS })).resolves.toEqual([
      'tests/café-ünïcode.test.ts',
    ]);
  });

  // IT-WORKTREE-8 — HEAD unresolvable (no commits) → rejects, never []
  it('rejects rather than reporting [] when the repo has no commits (fail toward firing)', async () => {
    const dir = repos.makeGitRepo('worktree-empty'); // git init, nothing committed → no HEAD
    repos.writeRepoFile(dir, 'tests/a.test.ts', 'a\n');
    await expect(workingTreeTestPaths({ repoDir: dir, testGlobs: TEST_GLOBS })).rejects.toThrow();
  });

  // IT-WORKTREE-CAP — the capabilities-sourced wrapper
  describe('workingTreeTestPathsFromCapabilities', () => {
    it('sources globs from loop-capabilities.yaml and returns matched working-tree paths', async () => {
      const dir = committed();
      writeLoopCapabilities(dir, { testGlobs: ['tests/**'] });
      repos.writeRepoFile(dir, 'tests/a.test.ts', 't\n');
      await expect(workingTreeTestPathsFromCapabilities({ repoDir: dir })).resolves.toEqual({
        ok: true,
        paths: ['tests/a.test.ts'],
      });
    });

    it('surfaces the absent cause when there is no loop-capabilities.yaml (engine can degrade/refuse)', async () => {
      const dir = committed();
      const result = await workingTreeTestPathsFromCapabilities({ repoDir: dir });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.cause).toBe('absent');
    });
  });
});
