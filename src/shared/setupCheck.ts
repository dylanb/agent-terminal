export type SetupConditionEntry =
  | { condition: 'examples'; failure: 'stale' | 'unchecked' }
  | { condition: 'ignore'; failure: 'not-ignored' | 'unchecked' }
  | { condition: 'capabilities'; failure: 'absent' | 'malformed' | 'confinement' };

export type SetupCondition = SetupConditionEntry['condition'];

export type SetupDismissal = { kind: 'repo'; repoKey: string } | { kind: 'examples'; appVersion: string };

/** The conditions a recorded dismissal stops the setup check listing. */
export function silencedBy(dismissal: SetupDismissal): SetupCondition[] {
  return dismissal.kind === 'repo' ? ['ignore', 'capabilities'] : ['examples'];
}
