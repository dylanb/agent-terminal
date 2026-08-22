import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createLoopCompletionPredicates } from '../../src/main/loopCompletionPredicates';
import { examplePhaseResult } from '../../src/shared/phaseResult';
import { createGitRepoFixture, type GitRepoFixture } from '../helpers/gitRepo';

describe('loopCompletionPredicates (§28.5.3 engine seam)', () => {
  it('classifies a known phase outcome and rejects an unknown one', () => {
    const predicates = createLoopCompletionPredicates();
    expect(predicates.classifyOutcome('passed')).toBe('passed');
    expect(predicates.classifyOutcome('failed-assertion')).toBe('failed-assertion');
    expect(predicates.classifyOutcome('nope')).toBeNull();
    expect(predicates.classifyOutcome('Passed')).toBeNull(); // never normalized
  });

  it('resultOutcome returns the outcome of a well-formed result file and null for a malformed one', () => {
    const predicates = createLoopCompletionPredicates();
    // a well-formed result (outcome ∈ set AND raw captured output present) yields its outcome:
    expect(predicates.resultOutcome(examplePhaseResult('failed-assertion'))).toBe('failed-assertion');
    expect(predicates.resultOutcome(examplePhaseResult('passed'))).toBe('passed');
    // an outcome with NO captured-output section is not well-formed (AC3) → null, even though the outcome parses:
    expect(predicates.resultOutcome('outcome: failed-assertion\n')).toBeNull();
    // an unknown outcome spelling → null:
    expect(predicates.resultOutcome('outcome: flaky\n\n## captured output\n\nx\n')).toBeNull();
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
  });
});
