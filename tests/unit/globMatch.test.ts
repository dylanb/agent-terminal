import { describe, it, expect } from 'vitest';
import { globMatch, matchesAnyGlob } from '../../src/main/globMatch';

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
});
