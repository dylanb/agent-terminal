// §28.5.3 — one injection point for "the machine ground truth about a turn": the framework-neutral outcome
// recognizer (§28.5.2) and the capabilities-sourced frozen-tests detection (§28.5.1) behind a seam named for
// that domain concept, not the mechanisms behind it (CLAUDE.md injection-seam rule).
import { isPhaseOutcome, type PhaseOutcome } from '../shared/phaseOutcome';
import {
  changedTestPathsFromCapabilities,
  workingTreeTestPathsFromCapabilities,
  type ChangedTestPathsResult,
  type WorkingTreeTestPathsResult,
} from './frozenTests';
import { checkRed, redCheckCommand, type RedCheckOutcome } from './redCheckGate';

export interface LoopCompletionPredicates {
  /** Recognize the framework-neutral outcome the agent claimed (§28.5.2); null if it is not a known category. */
  classifyOutcome(raw: string): PhaseOutcome | null;
  /** The test-glob files that changed since the RED baseline, per the BASELINE's committed capabilities
   *  (§28.5.1) — a git-blob read, so its failure arm is absent/malformed only (no `confinement`). With `head` →
   *  commit↔commit; with `head` OMITTED → baseline ↔ WORKING TREE, the GREEN frozen check run at completion
   *  before the phase commit lands (§28.5.3). */
  changedTestPaths(query: { repoDir: string; baseline: string; head?: string }): Promise<ChangedTestPathsResult>;
  /** §28.5.2a — the test-glob files this turn ADDED LINES to in the working tree (vs HEAD), per the repo's
   *  WORKING-TREE capabilities: the RED "a failing test was authored" ground truth. Its failure arm
   *  (absent/malformed/confinement — the working-tree loader can refuse) lets the RED gate surface a distinct reason. */
  workingTreeTestPaths(query: { repoDir: string }): Promise<WorkingTreeTestPathsResult>;
  /** §28.5.2a — the test command's real exit code for a turn, recovered best-effort from the session/tool log
   *  (§27.11), or null when unrecoverable. Where recoverable, the RED gate enforces the direction (exit 0 ⇒ not
   *  a RED failure). No live source ships today (N7/#92) — the default returns null, so the clause is dormant
   *  but real (the direction logic is exercised under an injected fake). */
  recoverExitCode(query: { repoDir: string; turnKey: string }): Promise<number | null>;
  /** §28.5.2 */
  redCheckCommand(repoDir: string): string | null;
  /** §28.5.3 */
  redCheck(query: { repoDir: string; resultPath: string; addedTestPaths: string[] }): Promise<RedCheckOutcome>;
}

export function createLoopCompletionPredicates(): LoopCompletionPredicates {
  return {
    classifyOutcome: (raw) => (isPhaseOutcome(raw) ? raw : null),
    changedTestPaths: (query) => changedTestPathsFromCapabilities(query),
    workingTreeTestPaths: (query) => workingTreeTestPathsFromCapabilities(query),
    recoverExitCode: () => Promise.resolve(null),
    redCheckCommand: (repoDir) => redCheckCommand(repoDir),
    redCheck: (query) => Promise.resolve(checkRed(query)),
  };
}
