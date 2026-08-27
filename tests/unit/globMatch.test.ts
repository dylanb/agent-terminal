import { describe, it, expect } from 'vitest';
import { globMatch, matchesAnyGlob } from '../../src/shared/globMatch';

describe('globMatch — supported subset: * ? ** over repo-relative posix paths', () => {
  it('matches an exact literal path', () => {
    expect(globMatch('tests/a.test.ts', 'tests/a.test.ts')).toBe(true);
    expect(globMatch('tests/a.test.ts', 'tests/b.test.ts')).toBe(false);
  });

  it('* matches within a segment but never across /', () => {
    expect(globMatch('*.test.ts', 'foo.test.ts')).toBe(true);
    expect(globMatch('*.test.ts', 'a/foo.test.ts')).toBe(false);
    expect(globMatch('tests/*.ts', 'tests/foo.ts')).toBe(true);
    expect(globMatch('tests/*.ts', 'tests/sub/foo.ts')).toBe(false);
  });

  it('** matches zero or more path segments', () => {
    expect(globMatch('tests/**/*.test.ts', 'tests/foo.test.ts')).toBe(true); // zero segments
    expect(globMatch('tests/**/*.test.ts', 'tests/a/b/foo.test.ts')).toBe(true); // two segments
    expect(globMatch('**', 'a/b/c')).toBe(true);
    expect(globMatch('src/**', 'src/a/b.ts')).toBe(true);
    expect(globMatch('src/**', 'lib/a/b.ts')).toBe(false);
  });

  it('a leading ** matches at the repository root and below', () => {
    expect(globMatch('**/*.spec.ts', 'foo.spec.ts')).toBe(true);
    expect(globMatch('**/*.spec.ts', 'a/b/foo.spec.ts')).toBe(true);
    expect(globMatch('**/*.spec.ts', 'a/b/foo.test.ts')).toBe(false);
  });

  it('? matches exactly one non-/ character', () => {
    expect(globMatch('foo?.ts', 'foo1.ts')).toBe(true);
    expect(globMatch('foo?.ts', 'foo.ts')).toBe(false);
    expect(globMatch('a?b', 'a/b')).toBe(false); // ? does not cross a segment boundary
  });

  it('? and * count whole characters, including non-BMP code points (surrogate pairs)', () => {
    // A non-BMP char (😀 = one code point, two UTF-16 units): ? is "one character", so it must match it, and *
    // must consume it as one — else a configured test path with such a name is silently missed by the frozen check.
    expect(globMatch('tests/?.ts', 'tests/😀.ts')).toBe(true);
    expect(globMatch('tests/*.ts', 'tests/😀😀.ts')).toBe(true);
    expect(globMatch('tests/?.ts', 'tests/😀x.ts')).toBe(false); // ? is ONE character, not two
  });

  it('a segment-count mismatch without ** never matches', () => {
    expect(globMatch('*.ts', 'a/b.ts')).toBe(false);
    expect(globMatch('a/b/c', 'a/b')).toBe(false);
    expect(globMatch('a/b', 'a/b/c')).toBe(false);
  });

  it('treats an unsupported glyph as a literal (documented subset)', () => {
    // A leading slash: git paths are repo-relative with no leading slash, so this never matches.
    expect(globMatch('/tests/**', 'tests/a.test.ts')).toBe(false);
    // A bracket class is not part of the subset — treated literally, so it only matches itself.
    expect(globMatch('tests/[ab].test.ts', 'tests/a.test.ts')).toBe(false);
    expect(globMatch('tests/[ab].test.ts', 'tests/[ab].test.ts')).toBe(true);
  });

  it('matchesAnyGlob is the OR over a list; the empty list matches nothing', () => {
    expect(matchesAnyGlob('tests/a.test.ts', ['src/**', 'tests/**'])).toBe(true);
    expect(matchesAnyGlob('docs/a.md', ['src/**', 'tests/**'])).toBe(false);
    expect(matchesAnyGlob('tests/a.test.ts', [])).toBe(false);
  });

  it('a pathological **-heavy pattern against a long non-matching path terminates and returns false', () => {
    // If ** were matched by exponential recursion this would hang; the polynomial DP returns promptly.
    const pattern = Array(30).fill('**').join('/') + '/x.test.ts';
    const path = Array(40).fill('a').join('/') + '/b.ts';
    expect(globMatch(pattern, path)).toBe(false);
  });

  it('rejects a match whose pattern×path CHARACTER product exceeds the work budget (untrusted-input DoS guard)', () => {
    // The budget counts characters, not segments: segmentMatch does O(pattern-chars × segment-chars) work, so
    // a single ~100k-char path segment against a 1024-char wildcard (a 1×1 SEGMENT product) would still drive
    // ~1e8 char comparisons synchronously in the main process (CWE-400/1333). Reject before matching.
    expect(() => globMatch('*'.repeat(1024), 'a'.repeat(100_000))).toThrow(/budget/i);
    const deep = (segs: number): string => Array(segs).fill('a').join('/');
    expect(() => globMatch(deep(1001), deep(1001))).toThrow(/budget/i);
    // A realistic pattern/path stays well under budget and still matches normally.
    expect(globMatch('tests/**', `tests/${deep(50)}/x.test.ts`)).toBe(true);
  });
});
