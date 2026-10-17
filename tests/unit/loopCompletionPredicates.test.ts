import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createLoopCompletionPredicates } from '../../src/main/loopCompletionPredicates';
import { createGitRepoFixture, type GitRepoFixture } from '../helpers/gitRepo';

describe('loopCompletionPredicates (§28.5.3 engine seam)', () => {
  it('classifies a known phase outcome and rejects an unknown one', () => {
    const predicates = createLoopCompletionPredicates();
    expect(predicates.classifyOutcome('passed')).toBe('passed');
    expect(predicates.classifyOutcome('failed-assertion')).toBe('failed-assertion');
    expect(predicates.classifyOutcome('nope')).toBeNull();
    expect(predicates.classifyOutcome('Passed')).toBeNull(); // never normalized
  });

  describe('changedTestPaths delegates to the capabilities-sourced detection', () => {
    let repos: GitRepoFixture;
    beforeEach(() => {
      repos = createGitRepoFixture();
    });
    afterEach(() => repos.cleanup());

    it('surfaces the absent-capabilities cause for a repo with no loop-capabilities.yaml', async () => {
      const dir = repos.makeGitRepo('predicates');
      repos.writeRepoFile(dir, 'tests/a.test.ts', 'a\n');
      const baseline = repos.commitAll(dir, 'seed');
      repos.writeRepoFile(dir, 'tests/a.test.ts', 'a2\n');
      const head = repos.commitAll(dir, 'edit');

      const result = await createLoopCompletionPredicates().changedTestPaths({ repoDir: dir, baseline, head });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.cause).toBe('absent');
    });

    it('surfaces the matched changed path when the repo has a loop-capabilities.yaml (success wiring)', async () => {
      const dir = repos.makeGitRepo('predicates-ok');
      repos.writeRepoFile(dir, 'loop-capabilities.yaml', 'test_globs: [tests/**]\ntest_command: t\nbuild_command: b\n');
      repos.writeRepoFile(dir, 'tests/a.test.ts', 'a\n');
      const baseline = repos.commitAll(dir, 'seed');
      repos.writeRepoFile(dir, 'tests/a.test.ts', 'a2\n');
      const head = repos.commitAll(dir, 'edit');

      const result = await createLoopCompletionPredicates().changedTestPaths({ repoDir: dir, baseline, head });
      expect(result).toEqual({ ok: true, paths: ['tests/a.test.ts'] });
    });

    it('workingTreeTestPaths delegates to the working-tree detection (absent cause for no loop-capabilities.yaml)', async () => {
      const dir = repos.makeGitRepo('predicates-wt');
      repos.writeRepoFile(dir, 'src/a.ts', 'a\n');
      repos.commitAll(dir, 'seed');
      repos.writeRepoFile(dir, 'tests/a.test.ts', 't\n'); // an added test, but no capabilities to source globs from
      const result = await createLoopCompletionPredicates().workingTreeTestPaths({ repoDir: dir });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.cause).toBe('absent');
    });
  });

  it('recoverExitCode returns null in the shipped default (no source wired — the N7/#92 dormant hook)', async () => {
    await expect(
      createLoopCompletionPredicates().recoverExitCode({ repoDir: '/nonexistent', turnKey: 'work-red' }),
    ).resolves.toBeNull();
  });
});
