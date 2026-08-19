// §28.5.5 — the framework-neutral phase-outcome vocabulary: the *category* of a test run's result, named
// so it does not know one runner from another (§28.5.2). A closed set, recognized by exact string equality
// and NEVER normalized, single-sourced here the way `DISPOSITIONS` is in roundReport.ts (§27.5): the same
// definition is consumed by the completion predicate (S3/S4), the prompt composer that tells the agent what
// to write, and the tests, so they cannot drift. The engine only recognizes membership — it never runs the
// test command (§28.5.4); the agent classifies its own run's output into one of these and the engine bounds
// the claim. Callers narrow an untrusted value to `string` before asking (S3/S4 read it out of a parsed
// result file); the guard does no coercion of its own.
export const PHASE_OUTCOMES = ['passed', 'failed-assertion', 'errored', 'no-tests-selected'] as const;
export type PhaseOutcome = (typeof PHASE_OUTCOMES)[number];

const PHASE_OUTCOME_SET: ReadonlySet<string> = new Set(PHASE_OUTCOMES);

export function isPhaseOutcome(value: string): value is PhaseOutcome {
  return PHASE_OUTCOME_SET.has(value);
}
