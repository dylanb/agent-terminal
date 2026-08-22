// A scriptable LoopCompletionPredicates for the RED/GREEN engine gate tests (§28.5.3). The domain-seam fake
// names the concepts, not git/log mechanisms (CLAUDE.md seam rule). resultOutcome/classifyOutcome use the REAL
// shared grammar (the tests script the result-file CONTENT via the engine's readArtifact, not this fn), so only
// the git ground-truth (workingTreeTestPaths) and the exit-code recovery are the per-test knobs.

import { isPhaseOutcome } from '../../src/shared/phaseOutcome';
import { phaseResultWellFormed, parsePhaseResult } from '../../src/shared/phaseResult';
import type { LoopCompletionPredicates } from '../../src/main/loopCompletionPredicates';
import type { TestPathsResult } from '../../src/main/frozenTests';

export function makeFakeCompletionPredicates(
  overrides: Partial<LoopCompletionPredicates> = {},
): LoopCompletionPredicates {
  return {
    classifyOutcome: (raw) => (isPhaseOutcome(raw) ? raw : null),
    resultOutcome: (content) => (phaseResultWellFormed(content) ? parsePhaseResult(content).outcome : null),
    changedTestPaths: async () => ({ ok: true, paths: [] }),
    workingTreeTestPaths: async () => ({ ok: true, paths: [] }),
    recoverExitCode: async () => null,
    ...overrides,
  };
}

/** A `workingTreeTestPaths` that stays pending until `resolve` is called — so the engine-level concurrency test
 *  (IT-ENGINE-8) can fire a concurrent event while the engine awaits the RED git gate. */
export function deferredWorkingTree(): {
  workingTreeTestPaths: LoopCompletionPredicates['workingTreeTestPaths'];
  resolve: (r: TestPathsResult) => void;
} {
  let resolve!: (r: TestPathsResult) => void;
  const pending = new Promise<TestPathsResult>((res) => {
    resolve = res;
  });
  return { workingTreeTestPaths: () => pending, resolve };
}
