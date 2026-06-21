import { describe, expect, it } from 'vitest';
import { isHumanNeededStatus } from '../../src/shared/loopStatus';

// §24.2.3 T4 / §19.1 — the shared human-needed family predicate is the SINGLE definition of "the loop
// is blocked awaiting a human", bound by both the renderer presentation and the main classifier so
// they cannot drift. Behavior under test = whether a status is in the family: the awaiting-human-*
// statuses and impasse are human-needed; the terminal hand-off and in-motion statuses are not.

describe('isHumanNeededStatus (shared family, §24.2.3 T4)', () => {
  it('counts the awaiting-human-* family as human-needed', () => {
    expect(isHumanNeededStatus('awaiting-human-pr-approval')).toBe(true);
    expect(isHumanNeededStatus('awaiting-human-impl-triage')).toBe(true);
    expect(isHumanNeededStatus('awaiting-human')).toBe(true);
  });

  it('counts an impasse as human-needed (the loop is blocked, not handed off)', () => {
    expect(isHumanNeededStatus('impasse')).toBe(true);
  });

  it('does not count the terminal hand-off awaiting-team-review as human-needed', () => {
    expect(isHumanNeededStatus('awaiting-team-review')).toBe(false);
  });

  it('does not count in-motion statuses as human-needed', () => {
    for (const s of ['impl-draft', 'impl-review', 'thinking', 'normal', 'running', ''])
      expect(isHumanNeededStatus(s)).toBe(false);
  });
});
