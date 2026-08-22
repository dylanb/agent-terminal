// §28.5.3 — one injection point for "the machine ground truth about a turn": the framework-neutral outcome
// recognizer (§28.5.2) and the capabilities-sourced frozen-tests detection (§28.5.1) behind a seam named for
// that domain concept, not the mechanisms behind it (CLAUDE.md injection-seam rule).
import { isPhaseOutcome, type PhaseOutcome } from '../shared/phaseOutcome';
import { phaseResultWellFormed, parsePhaseResult } from '../shared/phaseResult';
import { changedTestPathsFromCapabilities, type ChangedTestPathsResult } from './frozenTests';

export interface LoopCompletionPredicates {
  /** Recognize the framework-neutral outcome the agent claimed (§28.5.2); null if it is not a known category. */
  classifyOutcome(raw: string): PhaseOutcome | null;
  /** §28.5.2c/§28.5.3 — the classified outcome of a turn's RESULT FILE: parse + shape-validate the agent-written
   *  result (the phaseResult grammar) and return its outcome ONLY when the file is well-formed (a member of the
   *  closed set AND the raw captured output present — AC3); null when malformed/absent. The RED/GREEN completion
   *  gate (S3/S4) compares this against the phase's required outcome (`failed-assertion` / `passed`). Injected now
   *  so the seam exists; the gate call through it lands with the RED clause (S3). */
  resultOutcome(content: string): PhaseOutcome | null;
  /** The test-glob files that changed between the RED baseline and head, per the repo's capabilities (§28.5.1). */
  changedTestPaths(query: { repoDir: string; baseline: string; head: string }): Promise<ChangedTestPathsResult>;
}

export function createLoopCompletionPredicates(): LoopCompletionPredicates {
  return {
    classifyOutcome: (raw) => (isPhaseOutcome(raw) ? raw : null),
    resultOutcome: (content) => (phaseResultWellFormed(content) ? parsePhaseResult(content).outcome : null),
    changedTestPaths: (query) => changedTestPathsFromCapabilities(query),
  };
}
