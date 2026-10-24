import { afterEach, describe, expect, it } from 'vitest';
import '../../src/renderer/src/styles.css';
import '@xterm/xterm/css/xterm.css';
import { EXISTING_TOKENS, STATUS_TOKENS, type Theme } from '../helpers/designTokens';
import { UNRESOLVED, paintTokens, sameColor } from '../helpers/tokenProbe';
import { parseColor } from '../helpers/wcag';

const html = document.documentElement;
const THEMES: readonly Theme[] = ['light', 'dark'];

afterEach(() => {
  html.removeAttribute('data-theme');
});

/** Each token that paints a value: one some loaded stylesheet defines. */
function resolving(names: readonly string[]): string[] {
  const painted = paintTokens(names);
  return names.filter((name) => !sameColor(parseColor(painted[name]), parseColor(UNRESOLVED)));
}

describe.each(THEMES)('every renderer stylesheet except tokens.css, %s theme', (theme) => {
  it('defines no existing colour token', () => {
    if (theme === 'dark') html.setAttribute('data-theme', 'dark');
    expect(resolving(Object.keys(EXISTING_TOKENS))).toEqual([]);
  });

  it('defines no status token', () => {
    if (theme === 'dark') html.setAttribute('data-theme', 'dark');
    expect(resolving(Object.keys(STATUS_TOKENS))).toEqual([]);
  });
});
