import { describe, it, expect } from 'vitest';
import {
  BUILD_OUTCOMES,
  isBuildOutcome,
  GREEN_COMPLETING_BUILD_OUTCOME,
  type BuildOutcome,
} from '../../src/shared/buildOutcome';

// §28.5.3 — the build-outcome vocabulary the GREEN turn's result file carries alongside `outcome`. A closed,
// exact-string set the way phaseOutcome's is: recognized by equality, NEVER normalized, single-sourced so the
// GREEN prompt (writer), the GREEN completion gate (predicate), and the tests cannot drift.
describe('buildOutcome vocabulary (§28.5.3 / §28.5.5)', () => {
  it('is exactly the two framework-neutral build categories, in order', () => {
    expect(BUILD_OUTCOMES).toEqual(['built', 'build-failed']);
  });

  it('recognizes every member of the set', () => {
    for (const outcome of BUILD_OUTCOMES) {
      expect(isBuildOutcome(outcome)).toBe(true);
    }
  });

  it('rejects a value outside the set rather than accepting a novel build outcome', () => {
    expect(isBuildOutcome('passed')).toBe(false); // a test outcome is not a build outcome
    expect(isBuildOutcome('build')).toBe(false);
    expect(isBuildOutcome('failed')).toBe(false);
    expect(isBuildOutcome('')).toBe(false);
  });

  it('is never normalized — case and surrounding whitespace are not folded', () => {
    expect(isBuildOutcome('Built')).toBe(false);
    expect(isBuildOutcome('BUILT')).toBe(false);
    expect(isBuildOutcome(' built ')).toBe(false);
    expect(isBuildOutcome('built\n')).toBe(false);
    expect(isBuildOutcome('build_failed')).toBe(false);
  });

  it('the GREEN-completing build outcome is `built` and is a member', () => {
    expect(GREEN_COMPLETING_BUILD_OUTCOME).toBe('built');
    expect(isBuildOutcome(GREEN_COMPLETING_BUILD_OUTCOME)).toBe(true);
  });

  it('narrows to the BuildOutcome type at the boundary', () => {
    const raw = 'built';
    if (isBuildOutcome(raw)) {
      const narrowed: BuildOutcome = raw; // compile-gate: the guard narrows string → BuildOutcome
      expect(narrowed).toBe('built');
    } else {
      throw new Error('guard should have recognized a member');
    }
  });
});
