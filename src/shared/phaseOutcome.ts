// STUB (RED): surface present, recognizer recognizes nothing yet.
export const PHASE_OUTCOMES = ['passed', 'failed-assertion', 'errored', 'no-tests-selected'] as const;
export type PhaseOutcome = (typeof PHASE_OUTCOMES)[number];
const RECOGNIZED: ReadonlySet<string> = new Set();
export function isPhaseOutcome(value: string): value is PhaseOutcome {
  return RECOGNIZED.has(value);
}
