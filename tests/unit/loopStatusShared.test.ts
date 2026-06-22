import { describe, expect, it } from 'vitest';
import { isHumanNeededStatus } from '../../src/shared/loopStatus';

// §24.2.3 T4 / §19.1 — the shared human-needed predicate is the SINGLE definition bound by both the
// renderer presentation and the main classifier; if it drifts, the two disagree on what blocks.

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
