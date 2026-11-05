export type SetupConditionEntry =
  | { condition: 'ignore'; failure: 'not-ignored' | 'unchecked' }
  | { condition: 'capabilities'; failure: 'absent' | 'malformed' | 'confinement' };

export type SetupCondition = SetupConditionEntry['condition'];
