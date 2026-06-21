import { describe, expect, it } from 'vitest';
import { spillTone, toneLabel } from '../../src/renderer/src/loopStatus';

// §24.2.3 T2/T0 — the shared loop-status presentation maps an UNBOUNDED per-LoopDef `status` onto one
// of three generic tones (the rail read-out + the docked panel both derive from it): `await` = needs a
// human, `settle` = a terminal/approved end, `work` = in motion. Behavior under test = the tone a
// status resolves to and its one-word label; the exact vocabulary is the agent-loop v4 contract.

describe('loop status tone mapping (§24.2.3 T2)', () => {
  it('maps the awaiting-human-* family to the await tone', () => {
    expect(spillTone('awaiting-human-pr-approval')).toBe('await');
    expect(spillTone('awaiting-human-plan-approval')).toBe('await');
    expect(spillTone('awaiting-human')).toBe('await');
  });

  it('maps an impasse to the await tone (still needs a human)', () => {
    expect(spillTone('impasse')).toBe('await');
  });

  it('maps a terminal/approved end to the settle tone', () => {
    for (const s of ['merged', 'approved', 'done', 'complete', 'completed', 'shipped', 'closed', 'terminated'])
      expect(spillTone(s)).toBe('settle');
  });

  it('maps anything in motion to the work tone (the default)', () => {
    expect(spillTone('plan-draft')).toBe('work');
    expect(spillTone('impl-review')).toBe('work');
    expect(spillTone('running')).toBe('work');
    expect(spillTone('')).toBe('work');
  });

  it('treats awaiting-team-review as settled — it is the loop terminal gate, not a human-needed state', () => {
    // The bound impl-loop emits awaiting-team-review as a kind:terminal gate (next_status_on_approve),
    // so the rail must read it as settled, not "working" (contracts parity with the real LoopDef).
    expect(spillTone('awaiting-team-review')).toBe('settle');
    expect(toneLabel('awaiting-team-review')).toBe('settled');
    expect(spillTone('awaiting-human-pr-approval')).toBe('await'); // the human-needed family stays await
  });

  it('labels each tone with its compact one-word read-out', () => {
    expect(toneLabel('awaiting-human-pr-approval')).toBe('awaiting');
    expect(toneLabel('impl-draft')).toBe('working');
    expect(toneLabel('merged')).toBe('settled');
  });
});
