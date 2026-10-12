import { describe, expect, it } from 'vitest';
import { appTurnKey, parseAppTurnKey, type AppTurnPhase } from '../../src/main/appTurnKey';

describe('the §27 turn key', () => {
  it('names each phase and step so a reader recovers both', () => {
    for (const phase of ['work', 'review', 'consolidate'] as AppTurnPhase[]) {
      for (const stepId of ['b', 'plan-polish', 'review-x']) expect(parseAppTurnKey(appTurnKey(phase, stepId))).toEqual({ phase, stepId });
    }
  });

  it('reads nothing out of a key no phase composed', () => {
    for (const key of ['reply', 'polish-b', '', 'workb', 'work-', 'review-', 'consolidate-']) expect(parseAppTurnKey(key)).toBeNull();
  });
});
