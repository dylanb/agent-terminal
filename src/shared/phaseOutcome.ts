// §28.5.5 — the framework-neutral phase-outcome vocabulary, single-sourced like `DISPOSITIONS` (§27.5).
export const PHASE_OUTCOMES = ['passed', 'failed-assertion', 'errored', 'no-tests-selected'] as const;
export type PhaseOutcome = (typeof PHASE_OUTCOMES)[number];

const PHASE_OUTCOME_SET: ReadonlySet<string> = new Set(PHASE_OUTCOMES);

export function isPhaseOutcome(value: string): value is PhaseOutcome {
  return PHASE_OUTCOME_SET.has(value);
}

// §28.5.3 — the ONE outcome that completes a RED turn: a test that fails by ASSERTION (not a compile/import
// `errored`, not `passed`). Single-sourced here so the RED completion gate that compares against it and the RED
// work prompt that names it as the bar derive from one definition and cannot drift (CLAUDE.md shared-semantics).
export const RED_COMPLETING_OUTCOME: PhaseOutcome = 'failed-assertion';
