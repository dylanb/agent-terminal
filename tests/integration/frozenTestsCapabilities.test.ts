import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { changedTestPathsFromCapabilities } from '../../src/main/frozenTests';
import { LOOP_CAPABILITIES_FILENAME } from '../../src/shared/loopCapabilities';
import { createGitRepoFixture, type GitRepoFixture } from '../helpers/gitRepo';

// Integration slice — the two S1 primitives composed over the real file that will drive them in S3/S4:
// load loop-capabilities.yaml → feed its test_globs to the pure-git frozen-tests detection.
describe('changedTestPathsFromCapabilities (§28.5.1 + §28.5.4 composed)', () => {
  let repos: GitRepoFixture;
  beforeEach(() => {
    repos = createGitRepoFixture();
  });
  afterEach(() => repos.cleanup());

  it('sources test_globs from the repo capabilities and returns the changed test files', async () => {
    const dir = repos.makeGitRepo('frozen-caps');
    repos.writeRepoFile(dir, LOOP_CAPABILITIES_FILENAME, 'test_globs: [tests/**]\ntest_command: t\nbuild_command: b\n');
    repos.writeRepoFile(dir, 'tests/foo.test.ts', 'a\n');
    repos.writeRepoFile(dir, 'src/foo.ts', 's\n');
    const baseline = repos.commitAll(dir, 'seed');
    repos.writeRepoFile(dir, 'tests/foo.test.ts', 'a2\n');
    repos.writeRepoFile(dir, 'src/foo.ts', 's2\n');
    const head = repos.commitAll(dir, 'edit both');

    await expect(changedTestPathsFromCapabilities({ repoDir: dir, baseline, head })).resolves.toEqual({
      ok: true,
      paths: ['tests/foo.test.ts'],
    });
  });

  it('with head omitted, sources globs and returns the working-tree changed tests (§28.5.3 GREEN frozen check)', async () => {
    const dir = repos.makeGitRepo('frozen-caps-wt');
    repos.writeRepoFile(dir, LOOP_CAPABILITIES_FILENAME, 'test_globs: [tests/**]\ntest_command: t\nbuild_command: b\n');
    repos.writeRepoFile(dir, 'tests/foo.test.ts', 'a\n');
    const baseline = repos.commitAll(dir, 'seed (RED baseline)');
    repos.writeRepoFile(dir, 'tests/foo.test.ts', 'a2\n'); // uncommitted working-tree edit
    repos.writeRepoFile(dir, 'tests/new.test.ts', 'n\n'); // untracked add, not a frozen change

    await expect(changedTestPathsFromCapabilities({ repoDir: dir, baseline })).resolves.toEqual({
      ok: true,
      paths: ['tests/foo.test.ts'],
    });
  });

  it('with head omitted, sources globs from the BASELINE blob so a narrowed working-tree config cannot hide a test edit (§28.5.3 tamper-evidence)', async () => {
    // The GREEN agent controls the working tree, so if test_globs were read from THERE it could narrow tests/**
    // to src/** and make an edited tests/a.test.ts vanish from the frozen-check flag. The globs come from the RED
    // baseline's COMMITTED config instead — the head-omitted twin of the commit↔commit "narrowing the
    // working-tree config cannot hide a test edit" pin.
    const dir = repos.makeGitRepo('frozen-caps-wt-narrow');
    repos.writeRepoFile(dir, LOOP_CAPABILITIES_FILENAME, 'test_globs: [tests/**]\ntest_command: t\nbuild_command: b\n');
    repos.writeRepoFile(dir, 'tests/a.test.ts', 'a\n');
    const baseline = repos.commitAll(dir, 'seed (RED baseline, globs = tests/**)');
    repos.writeRepoFile(dir, LOOP_CAPABILITIES_FILENAME, 'test_globs: [src/**]\ntest_command: t\nbuild_command: b\n'); // narrowed, uncommitted
    repos.writeRepoFile(dir, 'tests/a.test.ts', 'a2\n'); // uncommitted edit to a frozen test

    await expect(changedTestPathsFromCapabilities({ repoDir: dir, baseline })).resolves.toEqual({
      ok: true,
      paths: ['tests/a.test.ts'], // still detected via the baseline's tests/**, not the narrowed working-tree src/**
    });
  });

  it('surfaces cause "absent" when the repo has no capabilities file', async () => {
    const dir = repos.makeGitRepo('frozen-caps-absent');
    repos.writeRepoFile(dir, 'tests/foo.test.ts', 'a\n');
    const baseline = repos.commitAll(dir, 'seed');
    repos.writeRepoFile(dir, 'tests/foo.test.ts', 'a2\n');
    const head = repos.commitAll(dir, 'edit');

    const result = await changedTestPathsFromCapabilities({ repoDir: dir, baseline, head });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.cause).toBe('absent');
  });

  it('rejects (not [] and not a load-failure) when the baseline commit is bad — fail toward firing', async () => {
    const dir = repos.makeGitRepo('frozen-caps-badbase');
    repos.writeRepoFile(dir, LOOP_CAPABILITIES_FILENAME, 'test_globs: [tests/**]\ntest_command: t\nbuild_command: b\n');
    repos.writeRepoFile(dir, 'tests/foo.test.ts', 'a\n');
    repos.commitAll(dir, 'seed');

    await expect(
      changedTestPathsFromCapabilities({
        repoDir: dir,
        baseline: '0000000000000000000000000000000000000000',
        head: 'HEAD',
      }),
    ).rejects.toThrow();
  });
});
