// §28.5.3 — the main-process home where the S1 machine-completion predicates plug into the §27.12 gate. S1
// stands this seam up and wires it onto the loop engine's surface; S3/S4 make the RED/GREEN completion gate
// call through it. Bundling the framework-neutral outcome recognizer (§28.5.2) with the capabilities-sourced
// frozen-tests detection (§28.5.1) gives the engine ONE injection point named for the domain concept — "the
// machine ground truth about a turn" — rather than the mechanisms behind it.
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
