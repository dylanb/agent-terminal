import { afterEach, describe, expect, it } from 'vitest';
import '../helpers/rendererTokens';
import '../../src/renderer/src/styles.css';
import { EXISTING_TOKENS, expectedColor, type ExistingToken, type Theme } from '../helpers/designTokens';
import { mismatchedTokens, paintColors, paintTokens } from '../helpers/tokenProbe';

const html = document.documentElement;
const THEMES: readonly Theme[] = ['light', 'dark'];
const EXISTING = Object.keys(EXISTING_TOKENS) as ExistingToken[];

afterEach(() => {
  html.removeAttribute('data-theme');
});

describe.each(THEMES)('the tokens as the windows load them, %s theme', (theme) => {
  it('resolves every existing colour token to its table value', () => {
    if (theme === 'dark') html.setAttribute('data-theme', 'dark');
    const expected = paintColors(EXISTING.map((name) => expectedColor(name, theme)));
    expect(mismatchedTokens(EXISTING, paintTokens(EXISTING), expected)).toEqual([]);
  });
});
