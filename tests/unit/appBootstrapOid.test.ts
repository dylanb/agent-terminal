import { describe, expect, it } from 'vitest';
import { isGitObjectId } from '../../src/shared/appBootstrap';

// Git object ids are exactly 40 (sha1) or exactly 64 (sha256) hex characters — never a length in
// between. A range check accepts values no git will ever produce.
describe('isGitObjectId', () => {
  it('accepts only the two real object-id widths', () => {
    expect(isGitObjectId('a'.repeat(40))).toBe(true);
    expect(isGitObjectId('a'.repeat(64))).toBe(true);
  });

  it('rejects a width between the two, and non-hex', () => {
    for (const width of [39, 41, 50, 63, 65]) {
      expect(isGitObjectId('a'.repeat(width)), `width ${width}`).toBe(false);
    }
    expect(isGitObjectId('A'.repeat(40))).toBe(false);
    expect(isGitObjectId('g'.repeat(40))).toBe(false);
  });
});
