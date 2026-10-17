import { describe, expect, it } from 'vitest';
import { exampleGoalProgress, parseGoalProgress } from '../../src/shared/goalProgress';

// §27.3 (v2.201) — the progress file a goal session keeps: the engine reads its leg and status to decide
// whether the session finished, checkpointed, or is blocked on the operator.

describe('the goal progress file (§27.3 v2.201)', () => {
  it.each([['working'], ['checkpoint'], ['done']] as const)('the example for %s parses to its leg and status', (status) => {
    expect(parseGoalProgress(exampleGoalProgress(2, status))).toEqual({ leg: 2, status, blocked: null });
  });

  it('the blocked example carries what the session needs from the operator', () => {
    const p = parseGoalProgress(exampleGoalProgress(1, 'blocked'));
    expect(p?.status).toBe('blocked');
    expect(p?.blocked).toMatch(/\S/);
  });

  it('reads the fields under any list bullet and among other notes', () => {
    const text = '# Goal progress\n\nSome notes first.\n\n* Leg: 3\n1. Status: checkpoint\n\n## Done so far\n- slice wired\n';
    expect(parseGoalProgress(text)).toEqual({ leg: 3, status: 'checkpoint', blocked: null });
  });

  it('returns the blocked section text as the reason', () => {
    const text = 'Leg: 1\nStatus: blocked\n\n## Blocked\nThe plan says both A and B.\nPick one.\n\n## Next\n- wait\n';
    expect(parseGoalProgress(text)?.blocked).toBe('The plan says both A and B.\nPick one.');
  });

  it.each([
    ['no leg', 'Status: done\n'],
    ['no status', 'Leg: 1\n'],
    ['a leg that is not a positive whole number', 'Leg: 0\nStatus: done\n'],
    ['a fractional leg', 'Leg: 1.5\nStatus: done\n'],
    ['an unknown status', 'Leg: 1\nStatus: finished\n'],
    ['blocked with nothing under Blocked', 'Leg: 1\nStatus: blocked\n\n## Blocked\n\n## Next\n'],
    ['blocked with no Blocked section', 'Leg: 1\nStatus: blocked\n'],
  ])('is not well-formed with %s', (_what, text) => {
    expect(parseGoalProgress(text)).toBeNull();
  });
});
