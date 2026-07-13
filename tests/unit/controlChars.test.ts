import { describe, expect, it } from 'vitest';
import { stripDisplayControlChars } from '../../src/shared/controlChars';

// Build the unsafe code points from numbers so no invisible character is ever a literal in this file.
const cp = (...codes: number[]): string => String.fromCharCode(...codes);

describe('stripDisplayControlChars — one strip for every repo-supplied string that reaches a human-facing sink (CWE-117 / CWE-1007 / CWE-116)', () => {
  it('replaces C0, C1, and DEL control characters with a space (one per code point, not deletion)', () => {
    expect(stripDisplayControlChars('a' + cp(0x00, 0x1f, 0x7f, 0x9f) + 'b')).toBe('a    b');
  });

  it('replaces the bidi controls, marks, and isolates used for Trojan-Source spoofing (CVE-2021-42574)', () => {
    const bidi = [0x061c, 0x200e, 0x200f, 0x202a, 0x202e, 0x2066, 0x2069];
    expect(stripDisplayControlChars('safe' + cp(...bidi) + 'end')).toBe('safe' + ' '.repeat(bidi.length) + 'end');
  });

  it('replaces line and paragraph separators that would otherwise break a single-line label mid-string', () => {
    expect(stripDisplayControlChars('one' + cp(0x2028) + 'two' + cp(0x2029) + 'three')).toBe('one two three');
  });

  it('replaces the zero-width space, word joiner, invisible operators, and BOM that have no place in a short label', () => {
    const invisible = [0x200b, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0xfeff];
    expect(stripDisplayControlChars('a' + cp(...invisible) + 'b')).toBe('a' + ' '.repeat(invisible.length) + 'b');
  });

  it('preserves ZWJ and ZWNJ, which carry legitimate emoji and script-shaping meaning', () => {
    const zwj = cp(0x200c, 0x200d);
    expect(stripDisplayControlChars(zwj)).toBe(zwj);
  });

  it('leaves ordinary text untouched', () => {
    expect(stripDisplayControlChars('Refactor the shadow parser')).toBe('Refactor the shadow parser');
  });
});
