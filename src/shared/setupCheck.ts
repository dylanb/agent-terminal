/** The catalog id of the bundled repo-setup flow, the one the setup popup's Run setup loop starts. */
export const REPO_SETUP_FLOW_ID = 'repo-setup';

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
