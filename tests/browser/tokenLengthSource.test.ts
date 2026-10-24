import { describe, expect, it } from 'vitest';
import '../../src/renderer/src/styles.css';
import '@xterm/xterm/css/xterm.css';
import { LENGTH_TOKENS, UNRESOLVED_LENGTH, paintLengths } from '../helpers/lengthTokens';

describe('every renderer stylesheet except tokens.css', () => {
  it('defines no non-colour token', () => {
    const names = Object.keys(LENGTH_TOKENS);
    expect(paintLengths(names)).toEqual(Object.fromEntries(names.map((name) => [name, UNRESOLVED_LENGTH])));
  });
});
