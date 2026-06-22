import { describe, expect, it } from 'vitest';
import { isRecord } from '../../src/main/yamlRecord';

// Arrays must be rejected because js-yaml loads a `- a\n- b` document as an array, which would
// otherwise pass a bare `typeof === 'object'` guard.
describe('isRecord (shared yaml record guard)', () => {
  it('accepts a plain object', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
  });
  it('rejects null, arrays, and primitives', () => {
    expect(isRecord(null)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord([1, 2])).toBe(false);
    expect(isRecord('x')).toBe(false);
    expect(isRecord(7)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
  });
});
