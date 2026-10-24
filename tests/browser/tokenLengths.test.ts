import { describe, expect, it } from 'vitest';
import '../helpers/rendererTokens';
import { LENGTH_TOKENS, paintLengths } from '../helpers/lengthTokens';

describe('tokens.css alone', () => {
  it('resolves every non-colour token to its value', () => {
    expect(paintLengths(Object.keys(LENGTH_TOKENS))).toEqual(LENGTH_TOKENS);
  });
});
