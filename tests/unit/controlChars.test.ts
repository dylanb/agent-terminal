import { describe, expect, it } from 'vitest';
import { stripDisplayControlChars } from '../../src/shared/controlChars';

// Build the unsafe code points from numbers so no invisible character is ever a literal in this file.
const cp = (...codes: number[]): string => String.fromCharCode(...codes);
const contains = (s: string, code: number): boolean => s.includes(String.fromCharCode(code));

describe('stripDisplayControlChars — one strip for every repo-supplied string that reaches a human-facing sink (CWE-117 / CWE-1007 / CWE-116)', () => {
  it('replaces C0, C1, and DEL control characters with a space', () => {
    const out = stripDisplayControlChars('a' + cp(0x00, 0x1f, 0x7f, 0x9f) + 'b');
    for (const c of [0x00, 0x1f, 0x7f, 0x9f]) expect(contains(out, c)).toBe(false);
    expect(out).toContain('a');
    expect(out).toContain('b');
  });

  it('strips the bidi controls, marks, and isolates used for Trojan-Source spoofing (CVE-2021-42574)', () => {
    const bidi = [0x061c, 0x200e, 0x200f, 0x202a, 0x202e, 0x2066, 0x2069];
    const out = stripDisplayControlChars('safe' + cp(...bidi) + 'end');
    for (const c of bidi) expect(contains(out, c)).toBe(false);
    expect(out).toContain('safe');
    expect(out).toContain('end');
  });

  it('strips line and paragraph separators that would otherwise break a single-line label mid-string', () => {
    const out = stripDisplayControlChars('one' + cp(0x2028) + 'two' + cp(0x2029) + 'three');
    for (const c of [0x2028, 0x2029]) expect(contains(out, c)).toBe(false);
  });

  it('strips the zero-width space and BOM/ZWNBSP that have no place in a short label', () => {
    const out = stripDisplayControlChars('a' + cp(0x200b) + 'b' + cp(0xfeff) + 'c');
    for (const c of [0x200b, 0xfeff]) expect(contains(out, c)).toBe(false);
  });

  it('preserves ZWJ and ZWNJ, which carry legitimate emoji and script-shaping meaning', () => {
    const zwj = cp(0x200c, 0x200d);
    expect(stripDisplayControlChars(zwj)).toBe(zwj);
  });

  it('leaves ordinary text untouched', () => {
    expect(stripDisplayControlChars('Refactor the shadow parser')).toBe('Refactor the shadow parser');
  });
});
