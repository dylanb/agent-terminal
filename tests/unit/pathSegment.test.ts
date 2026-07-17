import { describe, expect, it } from 'vitest';
import { isSafePathSegment } from '../../src/shared/pathSegment';

describe('isSafePathSegment (engine-neutral single-safe-segment predicate)', () => {
  it('accepts a lowercase alnum/hyphen segment that starts alnum', () => {
    expect(isSafePathSegment('plan-loop')).toBe(true);
    expect(isSafePathSegment('impl-loop')).toBe(true);
    expect(isSafePathSegment('groom-loop')).toBe(true);
    expect(isSafePathSegment('a')).toBe(true);
    expect(isSafePathSegment('review-security-1')).toBe(true);
  });

  it('rejects anything that is not a single safe path segment', () => {
    for (const bad of ['', '..', '.', 'a/b', 'a\\b', 'A', 'Plan', 'a_b', '.hidden', '-leading', 'has space', 'trailing/', '/leading', 'a.b', 'a..b']) {
      expect(isSafePathSegment(bad), `expected ${JSON.stringify(bad)} to be rejected`).toBe(false);
    }
  });
});
