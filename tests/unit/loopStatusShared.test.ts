import { describe, expect, it } from 'vitest';
import { isHumanNeededStatus, stripStatusControlChars } from '../../src/shared/loopStatus';

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

  it('counts the app-only error status as human-needed (§26.3/D48: a turn failed twice)', () => {
    expect(isHumanNeededStatus('error')).toBe(true);
  });

  it('does not count the terminal hand-off awaiting-team-review as human-needed', () => {
    expect(isHumanNeededStatus('awaiting-team-review')).toBe(false);
  });

  it('does not count in-motion statuses as human-needed', () => {
    for (const s of ['impl-draft', 'impl-review', 'thinking', 'normal', 'running', ''])
      expect(isHumanNeededStatus(s)).toBe(false);
  });
});

describe('stripStatusControlChars (shared CWE-117 strip, §16.3/§25.7)', () => {
  it('replaces every control-character class endpoint with a space', () => {
    expect(stripStatusControlChars('a\x00\x1f\x7fb')).toBe('a   b');
  });

  it('replaces an embedded newline with a space (no audit document-boundary forgery)', () => {
    expect(stripStatusControlChars('build\ning')).toBe('build ing');
  });

  it('leaves a normal printable status untouched', () => {
    expect(stripStatusControlChars('awaiting-human-pr-approval')).toBe('awaiting-human-pr-approval');
  });

  it('strips bidi-override characters so a repo status cannot spoof the notification or audit (CWE-1007)', () => {
    const rlo = String.fromCharCode(0x202e);
    expect(stripStatusControlChars(`await${rlo}ing`).includes(rlo)).toBe(false);
  });
});
