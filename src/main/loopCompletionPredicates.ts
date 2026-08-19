// STUB (RED): the seam is present but classifies/detects nothing yet.
import type { PhaseOutcome } from '../shared/phaseOutcome';
import type { ChangedTestPathsResult } from './frozenTests';

export interface LoopCompletionPredicates {
  classifyOutcome(raw: string): PhaseOutcome | null;
  changedTestPaths(query: { repoDir: string; baseline: string; head: string }): Promise<ChangedTestPathsResult>;
}

export function createLoopCompletionPredicates(): LoopCompletionPredicates {
  return {
    classifyOutcome: () => null,
    changedTestPaths: async () => ({ ok: false, cause: 'malformed', reason: 'unimplemented' }),
  };
}
