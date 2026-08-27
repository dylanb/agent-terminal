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

  it('returns an untracked test file added to the working tree (the common RED case)', async () => {
    const dir = committed();
    repos.writeRepoFile(dir, 'tests/new.test.ts', 't\n'); // untracked, uncommitted
    await expect(workingTreeTestPaths({ repoDir: dir, testGlobs: TEST_GLOBS })).resolves.toEqual(['tests/new.test.ts']);
  });

  it('returns a tracked test file whose modification ADDED lines', async () => {
    const dir = repos.makeGitRepo('worktree-tests');
    repos.writeRepoFile(dir, 'tests/a.test.ts', 'a\n');
    repos.commitAll(dir, 'seed with test');
    repos.writeRepoFile(dir, 'tests/a.test.ts', 'a\nb\n'); // +1 line
    await expect(workingTreeTestPaths({ repoDir: dir, testGlobs: TEST_GLOBS })).resolves.toEqual(['tests/a.test.ts']);
  });

  // §28.5.2a is "must ADD lines" — a turn that authored no failing test must NOT satisfy the clause. A pure
  // DELETION and a line-REMOVAL-only edit both have added-count 0, so both are excluded (the false-pass the
  // three review lanes caught: `git diff --name-only` would have counted a deletion as "a test was added").
  it('excludes a tracked test file that was only DELETED this turn (no false pass)', async () => {
    const dir = repos.makeGitRepo('worktree-tests');
    repos.writeRepoFile(dir, 'tests/a.test.ts', 'a\nb\nc\n');
    repos.commitAll(dir, 'seed with test');
    repos.removeRepoFile(dir, 'tests/a.test.ts'); // deleted in the working tree
    await expect(workingTreeTestPaths({ repoDir: dir, testGlobs: TEST_GLOBS })).resolves.toEqual([]);
  });

  it('excludes a tracked test file whose edit only REMOVED lines (added-count 0)', async () => {
    const dir = repos.makeGitRepo('worktree-tests');
    repos.writeRepoFile(dir, 'tests/a.test.ts', 'a\nb\nc\n');
    repos.commitAll(dir, 'seed with test');
    repos.writeRepoFile(dir, 'tests/a.test.ts', 'a\n'); // removed 2 lines, added 0
    await expect(workingTreeTestPaths({ repoDir: dir, testGlobs: TEST_GLOBS })).resolves.toEqual([]);
  });

  it('returns [] when only non-test files changed (the "you did not write a test" case)', async () => {
    const dir = committed();
    repos.writeRepoFile(dir, 'src/a.ts', 's2\n'); // modified source
    repos.writeRepoFile(dir, 'src/new.ts', 'n\n'); // new untracked source
    await expect(workingTreeTestPaths({ repoDir: dir, testGlobs: TEST_GLOBS })).resolves.toEqual([]);
  });

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

  it('returns only paths matching testGlobs, and rejects an empty testGlobs (fail toward firing)', async () => {
    const dir = committed();
    repos.writeRepoFile(dir, 'tests/x.test.ts', 't\n');
    repos.writeRepoFile(dir, 'docs/y.md', 'd\n');
    await expect(workingTreeTestPaths({ repoDir: dir, testGlobs: ['tests/**'] })).resolves.toEqual(['tests/x.test.ts']);
    await expect(workingTreeTestPaths({ repoDir: dir, testGlobs: [] })).rejects.toThrow();
  });

  it('detects a test file with a non-ASCII name (the -z contract)', async () => {
    const dir = committed();
    repos.writeRepoFile(dir, 'tests/café-ünïcode.test.ts', 'u\n');
    await expect(workingTreeTestPaths({ repoDir: dir, testGlobs: TEST_GLOBS })).resolves.toEqual([
      'tests/café-ünïcode.test.ts',
    ]);
  });

  // HEAD unresolvable (no commits) → rejects, never []
  it('rejects rather than reporting [] when the repo has no commits (fail toward firing)', async () => {
    const dir = repos.makeGitRepo('worktree-empty'); // git init, nothing committed → no HEAD
    repos.writeRepoFile(dir, 'tests/a.test.ts', 'a\n');
    await expect(workingTreeTestPaths({ repoDir: dir, testGlobs: TEST_GLOBS })).rejects.toThrow();
  });

  it('returns the union of both arms sorted (one path per arm, in unsorted arrival order)', async () => {
    const dir = repos.makeGitRepo('worktree-tests');
    repos.writeRepoFile(dir, 'tests/z.test.ts', 'z\n');
    repos.commitAll(dir, 'seed z');
    repos.writeRepoFile(dir, 'tests/z.test.ts', 'z\nz2\n'); // tracked-modified (diff arm) → arrives first
    repos.writeRepoFile(dir, 'tests/a.test.ts', 'a\n'); // untracked (ls-files arm) → arrives second
    // arrival is [z, a]; the result must be sorted → the .sort() is load-bearing here:
    await expect(workingTreeTestPaths({ repoDir: dir, testGlobs: TEST_GLOBS })).resolves.toEqual([
      'tests/a.test.ts',
      'tests/z.test.ts',
    ]);
  });

  it('detects a modified tracked test with a non-ASCII name on the diff arm (the -z contract)', async () => {
    const dir = repos.makeGitRepo('worktree-tests');
    repos.writeRepoFile(dir, 'tests/café-ünïcode.test.ts', 'u\n');
    repos.commitAll(dir, 'seed unicode');
    repos.writeRepoFile(dir, 'tests/café-ünïcode.test.ts', 'u\nv\n'); // tracked-modified, +1 line → diff arm
    await expect(workingTreeTestPaths({ repoDir: dir, testGlobs: TEST_GLOBS })).resolves.toEqual([
      'tests/café-ünïcode.test.ts',
    ]);
  });

  it('is not fooled by a repo-planted refs/replace/* substituting HEAD (tamper-evidence, --no-replace-objects)', async () => {
    // `git diff HEAD` re-hashes and looks up the HEAD tree, so a planted `git replace HEAD <older>` makes a
    // naive diff compare the working tree against the OLDER commit — a committed (not this-turn-added) test file
    // then shows as "added", forging a RED completion. The read must ignore replace refs (same posture as the
    // commit↔commit changedTestPaths tamper-evidence test), so an ALREADY-committed test stays out of the result.
    const dir = repos.makeGitRepo('worktree-replace');
    repos.writeRepoFile(dir, 'src/a.ts', 's\n');
    const older = repos.commitAll(dir, 'seed'); // no test file
    repos.writeRepoFile(dir, 'tests/a.test.ts', 't\n');
    repos.commitAll(dir, 'commit the test'); // the test is COMMITTED, not added this turn; working tree clean
    repos.git(dir, ['replace', 'HEAD', older]); // a naive `git diff HEAD` would diff against `older` (no test)
    await expect(workingTreeTestPaths({ repoDir: dir, testGlobs: TEST_GLOBS })).resolves.toEqual([]);
  });

  it('rejects rather than hangs when the aggregate glob×path matching work exceeds the budget (untrusted-input DoS)', async () => {
    // Same CWE-400 amplification the commit↔commit path bounds: many long globs × a long path. The working-tree
    // path runs on EVERY RED completion attempt (incl. retries), so the aggregate budget must apply here too.
    const dir = committed();
    const longSeg = (n: number): string => Array(n).fill('a').join('/');
    repos.writeRepoFile(dir, `tests/${longSeg(300)}.test.ts`, 'x\n'); // a ~600-byte untracked path added this turn
    const bloatedGlobs = Array(200).fill('z'.repeat(1000)); // 200k glob chars, none matching
    await expect(workingTreeTestPaths({ repoDir: dir, testGlobs: bloatedGlobs })).rejects.toThrow(/budget/i);
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
