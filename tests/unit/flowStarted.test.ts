import { describe, it, expect } from 'vitest';
import { isSelectionLocked } from '../../src/shared/flowStarted';

// §18.7.4 AC7 — the shared predicate the main-side pointer-write gate and A3's picker-enable both classify the
// raw started-ness signal through (single-sourced so the two processes cannot drift, the loopStatus.ts
// precedent). A new selection is locked once the run has begun; the fail-closed case (an indeterminate
// begun-ness must ALSO lock, never permit) is the safety-critical one — an attacker who corrupts the
// progression must not be able to unlock the gate (CWE-841).
describe('isSelectionLocked — the shared pointer-write gate predicate (§18.7.4 AC7)', () => {
  it('locks a new selection once the run has begun', () => {
    expect(isSelectionLocked('started')).toBe(true);
  });

  it('locks fail-closed while begun-ness is indeterminate (§18.7.4/CWE-841)', () => {
    expect(isSelectionLocked('indeterminate')).toBe(true);
  });

  it('permits a new selection only while the run has never started', () => {
    expect(isSelectionLocked('never-started')).toBe(false);
  });
});
