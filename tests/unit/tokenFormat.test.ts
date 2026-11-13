import { describe, expect, it } from 'vitest';
import { abbreviatedTokens, exactTokens } from '../../src/renderer/src/tokenFormat';
import { TOKEN_FORMAT_CASES } from '../helpers/tokenFormatFixture';

describe('token count format', () => {
  it.each(TOKEN_FORMAT_CASES)('the rail shows $n as $rail', ({ n, rail }) => {
    expect(abbreviatedTokens(n)).toBe(rail);
  });

  it.each(TOKEN_FORMAT_CASES)('the table shows $n as $table', ({ n, table }) => {
    expect(exactTokens(n)).toBe(table);
  });
});
