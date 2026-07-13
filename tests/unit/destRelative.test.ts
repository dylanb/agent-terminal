import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { destRelative } from '../../src/main/installExamples';

// The one mint for the exported DestRelativePath brand. The brand stops a plain `string` being passed
// implicitly; only this check stops a WRONG one — an absolute path, or one climbing out of its
// destination, would otherwise travel as a legal-looking value straight to a write (CWE-22). The guard is
// unreachable from today's callers by construction, which is exactly why it is pinned at its own boundary
// rather than left as a claim no test can falsify.

describe('destRelative', () => {
  it('accepts a plain relative path and a nested one', () => {
    expect(destRelative('flow.yaml')).toBe('flow.yaml');
    expect(destRelative(path.join('plan-loop', 'skills', 'review-intent', 'SKILL.md'))).toBe(
      path.join('plan-loop', 'skills', 'review-intent', 'SKILL.md'),
    );
  });

  it('normalises a redundant path rather than passing it through unchanged', () => {
    expect(destRelative(path.join('a', '.', 'b.md'))).toBe(path.join('a', 'b.md'));
    expect(destRelative(path.join('a', 'x', '..', 'b.md'))).toBe(path.join('a', 'b.md'));
  });

  it('refuses an absolute path', () => {
    expect(() => destRelative(path.resolve(path.sep, 'etc', 'passwd'))).toThrow(/destination-relative/);
  });

  it('refuses a path that climbs out of its destination', () => {
    expect(() => destRelative('..')).toThrow(/destination-relative/);
    expect(() => destRelative(path.join('..', '..', 'etc', 'passwd'))).toThrow(/destination-relative/);
    expect(() => destRelative(path.join('a', '..', '..', 'escape.md'))).toThrow(/destination-relative/);
  });
});
