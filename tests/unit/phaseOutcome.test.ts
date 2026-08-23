import { describe, it, expect } from 'vitest';
import {
  PHASE_OUTCOMES,
  isPhaseOutcome,
  GREEN_COMPLETING_OUTCOME,
  REFACTOR_COMPLETING_OUTCOME,
  type PhaseOutcome,
} from '../../src/shared/phaseOutcome';

describe('phaseOutcome vocabulary (§28.5.2 / §28.5.5)', () => {
  it('is exactly the four framework-neutral categories (a closed set; §28.5.5 assigns no order)', () => {
    // Compare as a set — §28.5.5 is a closed vocabulary with no order semantics, so a behavior-preserving
    // reorder must not fail this test; only a changed/added/removed member should.
    expect([...PHASE_OUTCOMES].sort()).toEqual(['errored', 'failed-assertion', 'no-tests-selected', 'passed']);
    expect(PHASE_OUTCOMES).toHaveLength(4);
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
    const raw: string = 'passed'; // string, not the literal 'passed', so the compile-gate below actually tests narrowing
    if (isPhaseOutcome(raw)) {
      const narrowed: PhaseOutcome = raw; // compile-gate: the guard narrows string → PhaseOutcome
      expect(narrowed).toBe('passed');
    } else {
      throw new Error('guard should have recognized a member');
    }
  });

  // §28.5.3 — the ONE test outcome that completes a GREEN turn is single-sourced here so the GREEN gate and the
  // GREEN prompt derive from one definition (the RED twin, RED_COMPLETING_OUTCOME, already lives beside it).
  it('the GREEN-completing outcome is `passed` and is a member of the set', () => {
    expect(GREEN_COMPLETING_OUTCOME).toBe('passed');
    expect(isPhaseOutcome(GREEN_COMPLETING_OUTCOME)).toBe(true);
  });

  // §28.5.3 — the ONE test outcome that completes a REFACTOR ROUND is single-sourced here so the refactor
  // round gate and the refactor prompt derive from one definition (the RED/GREEN twins beside it). It is
  // `passed` (a refactor keeps the tests green) — the softer bar carries no build/exit clause.
  it('the REFACTOR-completing outcome is `passed` and is a member of the set', () => {
    expect(REFACTOR_COMPLETING_OUTCOME).toBe('passed');
    expect(isPhaseOutcome(REFACTOR_COMPLETING_OUTCOME)).toBe(true);
  });
});
