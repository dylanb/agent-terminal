import { describe, expect, it } from 'vitest';
import { composeGateQuestion } from '../../src/shared/gateQuestion';
import { autoHaltReasonText } from '../../src/shared/gateAuthority';

// §27.9.1 N9b.10

describe('composeGateQuestion — an `auto` gate halt', () => {
  const q = composeGateQuestion({
    kind: 'halted',
    step: 'green',
    reasons: [{ reason: 'frozen-tests-changed', detail: 'tests/frozen.test.ts, tests/other.test.ts' }, { reason: 'needs-a-human' }],
  });

  it('names the step', () => {
    expect(q).toContain('`green`');
  });

  it('names every halt reason with its letter, label and detail', () => {
    expect(q).toContain('(d) frozen tests changed: tests/frozen.test.ts, tests/other.test.ts');
    expect(q).toContain('(a) needs a human');
  });

});

describe('composeGateQuestion — a human-authority gate', () => {
  const q = composeGateQuestion({ kind: 'human-gate', step: 'plan-approve' });

  it('says the gate is the operator\'s by design and names the step', () => {
    expect(q).toContain('`plan-approve`');
    expect(q).toMatch(/the operator's by design/);
  });

  it('names no halt reason', () => {
    expect(q).not.toMatch(/\([a-l]\) /);
  });
});

describe('composeGateQuestion — repo-supplied detail', () => {
  it('cannot break the question across lines or carry control characters', () => {
    const q = composeGateQuestion({ kind: 'halted', step: 'green', reasons: [{ reason: 'frozen-tests-changed', detail: `a.test.ts\n${String.fromCharCode(0x1b)}[201~b.test.ts` }] });
    const line = q.split('\n').find((l) => l.includes('frozen tests changed'));
    expect(line).toContain('a.test.ts');
    expect(line).toContain('b.test.ts');
    expect(q).not.toContain(String.fromCharCode(0x1b));
  });
});

describe('autoHaltReasonText — one rendering for the panel and the question', () => {
  it('prefixes the letter and appends the detail', () => {
    expect(autoHaltReasonText({ reason: 'frozen-tests-changed', detail: 'tests/x.test.ts' })).toBe('(d) frozen tests changed: tests/x.test.ts');
  });

  it('omits the letter for the §27.6 verdict and the colon when there is no detail', () => {
    expect(autoHaltReasonText({ reason: 'stop-for-a-human' })).toBe('stop for a human');
  });
});
