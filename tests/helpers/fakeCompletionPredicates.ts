// A scriptable LoopCompletionPredicates for the RED/GREEN engine gate tests (§28.5.3). The domain-seam fake
// INHERITS the real classifyOutcome/resultOutcome (the shared grammar — no re-spelling, so it cannot drift from
// production's composition) and overrides only the git/log ground truth (workingTreeTestPaths, changedTestPaths,
// recoverExitCode) a unit test can't drive, with inert defaults + per-test knobs.

import {
  createLoopCompletionPredicates,
  type LoopCompletionPredicates,
} from '../../src/main/loopCompletionPredicates';
import type { ChangedTestPathsResult, WorkingTreeTestPathsResult } from '../../src/main/frozenTests';

export function makeFakeCompletionPredicates(
  overrides: Partial<LoopCompletionPredicates> = {},
): LoopCompletionPredicates {
  return {
    ...createLoopCompletionPredicates(), // the REAL classifyOutcome/resultOutcome (shared grammar)
    changedTestPaths: async () => ({ ok: true, paths: [] }),
    workingTreeTestPaths: async () => ({ ok: true, paths: [] }),
    recoverExitCode: async () => null,
    redCheckCommand: () => null,
    redCheck: async () => ({ kind: 'unconfigured' }),
    ...overrides,
  };
}

/** A `workingTreeTestPaths` that stays pending until `resolve` is called — so the engine-level concurrency test
 *  can fire a concurrent event while the engine awaits the RED git gate. */
export function deferredWorkingTree(): {
  workingTreeTestPaths: LoopCompletionPredicates['workingTreeTestPaths'];
  resolve: (r: WorkingTreeTestPathsResult) => void;
} {
  let resolve!: (r: WorkingTreeTestPathsResult) => void;
  const pending = new Promise<WorkingTreeTestPathsResult>((res) => {
    resolve = res;
  });
  return { workingTreeTestPaths: () => pending, resolve };
}

/** A `changedTestPaths` that stays pending until `resolve` is called — the GREEN-gate twin of
 *  `deferredWorkingTree`, so an engine-level concurrency test can fire a concurrent event (a stall, a retry, a
 *  duplicate signal) while the engine awaits the GREEN frozen check. */
export function deferredChangedTestPaths(): {
  changedTestPaths: LoopCompletionPredicates['changedTestPaths'];
  resolve: (r: ChangedTestPathsResult) => void;
} {
  let resolve!: (r: ChangedTestPathsResult) => void;
  const pending = new Promise<ChangedTestPathsResult>((res) => {
    resolve = res;
  });
  return { changedTestPaths: () => pending, resolve };
}
