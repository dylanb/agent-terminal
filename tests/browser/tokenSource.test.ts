import { afterEach, describe, expect, it } from 'vitest';
import '../../src/renderer/src/styles.css';
import '@xterm/xterm/css/xterm.css';
import { EXISTING_TOKEN_NAMES, LENGTH_TOKEN_NAMES, STATUS_TOKEN_NAMES, type Theme } from '../helpers/designTokens';
import { readColors, readLengths } from '../helpers/tokenProbe';

const html = document.documentElement;
const THEMES: readonly Theme[] = ['light', 'dark'];

afterEach(() => {
  html.removeAttribute('data-theme');
});

function defined(values: Record<string, unknown>): string[] {
  return Object.keys(values).filter((name) => values[name] !== null);
}

describe.each(THEMES)('every renderer stylesheet except tokens.css, %s theme', (theme) => {
  it('defines no existing colour token', () => {
    if (theme === 'dark') html.setAttribute('data-theme', 'dark');
    expect(defined(readColors(EXISTING_TOKEN_NAMES))).toEqual([]);
  });

  it('defines no status token', () => {
    if (theme === 'dark') html.setAttribute('data-theme', 'dark');
    expect(defined(readColors(STATUS_TOKEN_NAMES))).toEqual([]);
  });

  it('defines no non-colour token', () => {
    if (theme === 'dark') html.setAttribute('data-theme', 'dark');
    expect(defined(readLengths(LENGTH_TOKEN_NAMES))).toEqual([]);
  });
});
