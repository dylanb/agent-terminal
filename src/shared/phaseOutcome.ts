// §28.5.5 — the framework-neutral phase-outcome vocabulary, single-sourced like `DISPOSITIONS` (§27.5).
export const PHASE_OUTCOMES = ['passed', 'failed-assertion', 'errored', 'no-tests-selected'] as const;
export type PhaseOutcome = (typeof PHASE_OUTCOMES)[number];

const PHASE_OUTCOME_SET: ReadonlySet<string> = new Set(PHASE_OUTCOMES);

export function isPhaseOutcome(value: string): value is PhaseOutcome {
  return PHASE_OUTCOME_SET.has(value);
}
