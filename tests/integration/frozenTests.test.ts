import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { changedTestPaths } from '../../src/main/frozenTests';
import { createGitRepoFixture, type GitRepoFixture } from '../helpers/gitRepo';

// §28.5.1 — the pure-git frozen-tests detection, exercised against REAL temporary repositories (no mock git).
describe('changedTestPaths (§28.5.1)', () => {
  let repos: GitRepoFixture;
  const TEST_GLOBS = ['tests/**'];

  beforeEach(() => {
    repos = createGitRepoFixture();
  });
  afterEach(() => repos.cleanup());

  /** Seed a repo with a test file + a source file, commit, and return { dir, baseline }. */
  function seeded(): { dir: string; baseline: string } {
    const dir = repos.makeGitRepo('frozen-tests');
    repos.writeRepoFile(dir, 'tests/a.test.ts', 'a\n');
    repos.writeRepoFile(dir, 'src/a.ts', 's\n');
    const baseline = repos.commitAll(dir, 'seed');
    return { dir, baseline };
  }

  it('returns a test-glob file that changed between baseline and head', async () => {
    const { dir, baseline } = seeded();
    repos.writeRepoFile(dir, 'tests/a.test.ts', 'a2\n');
    const head = repos.commitAll(dir, 'edit test');
    await expect(changedTestPaths({ repoDir: dir, baseline, head, testGlobs: TEST_GLOBS })).resolves.toEqual([
      'tests/a.test.ts',
    ]);
  });

  it('returns [] when only a non-test file changed (never reports a non-test path)', async () => {
    const { dir, baseline } = seeded();
    repos.writeRepoFile(dir, 'src/a.ts', 's2\n');
    const head = repos.commitAll(dir, 'edit source');
    await expect(changedTestPaths({ repoDir: dir, baseline, head, testGlobs: TEST_GLOBS })).resolves.toEqual([]);
  });

  it('reports an added test file and ignores an added source file', async () => {
    const { dir, baseline } = seeded();
    repos.writeRepoFile(dir, 'tests/b.test.ts', 'b\n');
    repos.writeRepoFile(dir, 'src/b.ts', 's\n');
    const head = repos.commitAll(dir, 'add both');
    await expect(changedTestPaths({ repoDir: dir, baseline, head, testGlobs: TEST_GLOBS })).resolves.toEqual([
      'tests/b.test.ts',
    ]);
  });

  it('returns every changed test file, sorted and deduped', async () => {
    const { dir, baseline } = seeded();
    repos.writeRepoFile(dir, 'tests/z.test.ts', 'z\n');
    repos.writeRepoFile(dir, 'tests/a.test.ts', 'a2\n');
    repos.writeRepoFile(dir, 'tests/m.test.ts', 'm\n');
    const head = repos.commitAll(dir, 'many');
    await expect(changedTestPaths({ repoDir: dir, baseline, head, testGlobs: TEST_GLOBS })).resolves.toEqual([
      'tests/a.test.ts',
      'tests/m.test.ts',
      'tests/z.test.ts',
    ]);
  });

  it('returns [] when nothing changed between baseline and head', async () => {
    const { dir, baseline } = seeded();
    await expect(
      changedTestPaths({ repoDir: dir, baseline, head: baseline, testGlobs: TEST_GLOBS }),
    ).resolves.toEqual([]);
  });

  it('detects a change to a test file with a non-ASCII name (the -z / quotePath contract)', async () => {
    const { dir, baseline } = seeded();
    repos.writeRepoFile(dir, 'tests/café-ünïcode.test.ts', 'u\n');
    const head = repos.commitAll(dir, 'unicode test');
    await expect(changedTestPaths({ repoDir: dir, baseline, head, testGlobs: TEST_GLOBS })).resolves.toEqual([
      'tests/café-ünïcode.test.ts',
    ]);
  });

  it('flags a test moved out of the test tree (--no-renames decomposes rename to delete+add)', async () => {
    const { dir, baseline } = seeded();
    repos.removeRepoFile(dir, 'tests/a.test.ts');
    repos.writeRepoFile(dir, 'src/a.ts', 'a\n'); // same content lands as a non-test path
    const head = repos.commitAll(dir, 'move test out');
    await expect(changedTestPaths({ repoDir: dir, baseline, head, testGlobs: TEST_GLOBS })).resolves.toEqual([
      'tests/a.test.ts',
    ]);
  });

  it('accepts a symbolic head ref (HEAD)', async () => {
    const { dir, baseline } = seeded();
    repos.writeRepoFile(dir, 'tests/a.test.ts', 'a2\n');
    repos.commitAll(dir, 'edit');
    await expect(
      changedTestPaths({ repoDir: dir, baseline, head: 'HEAD', testGlobs: TEST_GLOBS }),
    ).resolves.toEqual(['tests/a.test.ts']);
  });

  it('rejects rather than reporting [] when the baseline commit does not exist (fail toward firing)', async () => {
    const { dir } = seeded();
    await expect(
      changedTestPaths({
        repoDir: dir,
        baseline: '0000000000000000000000000000000000000000',
        head: 'HEAD',
        testGlobs: TEST_GLOBS,
      }),
    ).rejects.toThrow();
  });

  it('rejects an empty testGlobs list rather than silently reporting [] (fail toward firing)', async () => {
    const { dir, baseline } = seeded();
    repos.writeRepoFile(dir, 'tests/a.test.ts', 'a2\n');
    const head = repos.commitAll(dir, 'edit');
    await expect(changedTestPaths({ repoDir: dir, baseline, head, testGlobs: [] })).rejects.toThrow();
  });

  it('rejects a baseline that is not a git object id (option-injection defense)', async () => {
    const { dir } = seeded();
    await expect(
      changedTestPaths({ repoDir: dir, baseline: '--upload-pack=evil', head: 'HEAD', testGlobs: TEST_GLOBS }),
    ).rejects.toThrow();
  });
});
