// §28.5.5 — the phase-outcome vocabulary. A closed set, matched by exact string equality and NEVER normalized,
// single-sourced here the way `DISPOSITIONS` is (§27.5) so every reader shares one definition and cannot drift.
export const PHASE_OUTCOMES = ['passed', 'failed-assertion', 'errored', 'no-tests-selected'] as const;
export type PhaseOutcome = (typeof PHASE_OUTCOMES)[number];

const PHASE_OUTCOME_SET: ReadonlySet<string> = new Set(PHASE_OUTCOMES);

export function isPhaseOutcome(value: string): value is PhaseOutcome {
  return PHASE_OUTCOME_SET.has(value);
}
