import { describe, expect, it } from 'vitest';
import {
  EXISTING_TOKENS,
  STATUS_TOKENS,
  STATUSES,
  expectedColor,
  type StatusTokenSpec,
} from '../helpers/designTokens';

describe('design token table', () => {
  it('holds the 36 existing colour tokens and the 17 status tokens of the #245 contract', () => {
    expect(Object.keys(EXISTING_TOKENS)).toHaveLength(36);
    expect(Object.keys(STATUS_TOKENS)).toHaveLength(17);
    expect(STATUSES).toEqual(['error', 'needs-human', 'working', 'completed', 'idle']);
  });

  it('resolves an existing token to its own value in each theme', () => {
    expect(expectedColor('--card', 'light')).toBe('#FFFFFF');
    expect(expectedColor('--card', 'dark')).toBe('#161E27');
  });

  it('resolves an alias to the aliased token in the same theme', () => {
    expect(expectedColor('--status-working', 'light')).toBe(expectedColor('--signal', 'light'));
    expect(expectedColor('--status-working', 'dark')).toBe(expectedColor('--signal', 'dark'));
    expect(expectedColor('--status-error-text', 'dark')).toBe(expectedColor('--danger', 'dark'));
  });

  it('resolves a new status token to its own starting value in each theme', () => {
    expect(expectedColor('--status-needs-human', 'light')).toBe('#C97F14');
    expect(expectedColor('--status-needs-human', 'dark')).toBe('#FFB454');
  });

  it('cannot express an illegal status token', () => {
    // @ts-expect-error a status token is an alias or a pair of values, never both
    const both: StatusTokenSpec = { alias: '--attn', light: '#000000', dark: '#000000' };
    // @ts-expect-error an alias names an existing token
    const dangling: StatusTokenSpec = { alias: '--attn-wash' };
    // @ts-expect-error a new value is given for both themes
    const oneTheme: StatusTokenSpec = { light: '#000000' };
    expect([both, dangling, oneTheme]).toHaveLength(3);
  });
});
