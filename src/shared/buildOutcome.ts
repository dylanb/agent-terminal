// §28.5.3 — the framework-neutral BUILD-outcome vocabulary the GREEN turn's result file carries alongside the
// test `outcome` (§28.5.5): the *category* of the build command's result, named so it does not know one build
// system from another. A closed set, recognized by exact string equality and NEVER normalized, single-sourced
// here the way `PHASE_OUTCOMES` is: the same definition is consumed by the GREEN completion predicate, the GREEN
// prompt composer that tells the agent what to write, and the tests, so they cannot drift. Distinct from the
// test-outcome vocabulary — §28.5.3 gates GREEN on `outcome == passed` AND `build outcome == built` as two
// separate conjuncts, and a test-level `errored` (compile/import at the test) is not a build-command failure.
// The engine only recognizes membership — the agent runs the build (§28.5.4) and classifies its own output.
export const BUILD_OUTCOMES = ['built', 'build-failed'] as const;
export type BuildOutcome = (typeof BUILD_OUTCOMES)[number];

const BUILD_OUTCOME_SET: ReadonlySet<string> = new Set(BUILD_OUTCOMES);

export function isBuildOutcome(value: string): value is BuildOutcome {
  return BUILD_OUTCOME_SET.has(value);
}

// §28.5.3 — the ONE build outcome that completes a GREEN turn: the build succeeded. Single-sourced here so the
// GREEN completion gate that compares against it and the GREEN work prompt that names it as the bar derive from
// one definition and cannot drift (CLAUDE.md shared-semantics), mirroring RED_COMPLETING_OUTCOME.
export const GREEN_COMPLETING_BUILD_OUTCOME: BuildOutcome = 'built';
