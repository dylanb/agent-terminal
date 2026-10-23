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

// §28.5.3 — the outcome of a verification-only RED: every new test passed because the slice's behavior already
// exists. The result reader requires it of a verification claim, and the RED prompt names it.
export const RED_VERIFICATION_OUTCOME: PhaseOutcome = 'passed';

// §28.5.3 — the ONE test outcome that completes a GREEN turn: the tests ran and all passed. Single-sourced here
// (the RED twin above) so the GREEN completion gate and the GREEN work prompt derive from one definition. GREEN
// additionally requires `build == built` (src/shared/buildOutcome.ts), which is an orthogonal classification.
export const GREEN_COMPLETING_OUTCOME: PhaseOutcome = 'passed';

// §28.5.3 — the ONE test outcome that completes a REFACTOR ROUND: the tests still pass after the round's fixes.
// Single-sourced here (the RED/GREEN twins above) so the refactor round gate and the refactor prompt derive
// from one definition. Softer than GREEN only in carrying NO build clause — it keeps GREEN's exit-direction
// (§28.5.3:124).
export const REFACTOR_COMPLETING_OUTCOME: PhaseOutcome = 'passed';
