// §28.5.3 — one injection point for "the machine ground truth about a turn": the framework-neutral outcome
// recognizer (§28.5.2) and the capabilities-sourced frozen-tests detection (§28.5.1) behind a seam named for
// that domain concept, not the mechanisms behind it (CLAUDE.md injection-seam rule).
import { isPhaseOutcome, type PhaseOutcome } from '../shared/phaseOutcome';
import { changedTestPathsFromCapabilities, type ChangedTestPathsResult } from './frozenTests';

export interface LoopCompletionPredicates {
  /** Recognize the framework-neutral outcome the agent claimed (§28.5.2); null if it is not a known category. */
  classifyOutcome(raw: string): PhaseOutcome | null;
  /** The test-glob files that changed between the RED baseline and head, per the repo's capabilities (§28.5.1). */
  changedTestPaths(query: { repoDir: string; baseline: string; head: string }): Promise<ChangedTestPathsResult>;
}

export function createLoopCompletionPredicates(): LoopCompletionPredicates {
  return {
    classifyOutcome: (raw) => (isPhaseOutcome(raw) ? raw : null),
    changedTestPaths: (query) => changedTestPathsFromCapabilities(query),
  };
}
