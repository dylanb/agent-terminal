import { describe, it, expect } from 'vitest';
import { PHASE_OUTCOMES, isPhaseOutcome, type PhaseOutcome } from '../../src/shared/phaseOutcome';

describe('phaseOutcome vocabulary (§28.5.2 / §28.5.5)', () => {
  it('is exactly the four framework-neutral categories, in order', () => {
    expect(PHASE_OUTCOMES).toEqual(['passed', 'failed-assertion', 'errored', 'no-tests-selected']);
  });

  it('recognizes every member of the set', () => {
    for (const outcome of PHASE_OUTCOMES) {
      expect(isPhaseOutcome(outcome)).toBe(true);
    }
  });

  it('rejects a value outside the set rather than accepting it as a novel outcome', () => {
    expect(isPhaseOutcome('flaky')).toBe(false);
    expect(isPhaseOutcome('pass')).toBe(false);
    expect(isPhaseOutcome('')).toBe(false);
  });

  it('is never normalized — case and surrounding whitespace are not folded', () => {
    expect(isPhaseOutcome('Passed')).toBe(false);
    expect(isPhaseOutcome('PASSED')).toBe(false);
    expect(isPhaseOutcome(' passed ')).toBe(false);
    expect(isPhaseOutcome('passed\n')).toBe(false);
    expect(isPhaseOutcome('failed-assertion ')).toBe(false);
  });

  it('narrows to the PhaseOutcome type at the boundary', () => {
    const raw = 'passed';
    if (isPhaseOutcome(raw)) {
      const narrowed: PhaseOutcome = raw; // compile-gate: the guard narrows string → PhaseOutcome
      expect(narrowed).toBe('passed');
    } else {
      throw new Error('guard should have recognized a member');
    }
  });
});
