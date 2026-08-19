import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { changedTestPathsFromCapabilities } from '../../src/main/frozenTests';
import { LOOP_CAPABILITIES_FILENAME } from '../../src/main/loopCapabilities';
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
