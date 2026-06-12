import { describe, expect, it } from 'vitest';
import { PASTE_END, PASTE_START, stripPasteBreakout } from '../../src/shared/paste';

describe('stripPasteBreakout (§7.5/§9.3)', () => {
  it('removes an embedded paste-end marker', () => {
    expect(stripPasteBreakout(`bad${PASTE_END}rm`)).toBe('badrm');
  });

  it('removes every occurrence', () => {
    expect(stripPasteBreakout(`${PASTE_END}a${PASTE_END}b${PASTE_END}`)).toBe('ab');
  });

  it('leaves marker-free text untouched', () => {
    expect(stripPasteBreakout('hello world')).toBe('hello world');
  });

  it('exposes the bracketed-paste fence bytes as the contract', () => {
    expect(PASTE_START).toBe('\x1b[200~');
    expect(PASTE_END).toBe('\x1b[201~');
  });
});
