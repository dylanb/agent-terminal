import { describe, expect, it } from 'vitest';
import {
  EXISTING_TOKEN_NAMES,
  LENGTH_TOKEN_NAMES,
  STATUS_TOKEN_NAMES,
  STATUSES,
  aliasOf,
  expectedColor,
  expectedLength,
} from '../helpers/designTokens';

describe('design token table', () => {
  it('names the 36 existing colour tokens, the 17 status tokens of the #245 contract and the 4 non-colour tokens', () => {
    expect(EXISTING_TOKEN_NAMES).toHaveLength(36);
    expect(STATUS_TOKEN_NAMES).toHaveLength(17);
    expect(LENGTH_TOKEN_NAMES).toEqual(['--focus-ring-w', '--focus-ring-offset', '--focus-ring-extent', '--r']);
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

  it('names the target of each aliased status token, and none for a new value', () => {
    expect(aliasOf('--status-error-text')).toBe('--danger');
    expect(aliasOf('--status-idle-tint')).toBe('--hair2');
    expect(aliasOf('--status-needs-human')).toBeNull();
    expect(STATUS_TOKEN_NAMES.filter((name) => aliasOf(name) !== null)).toHaveLength(9);
  });

  it('gives each non-colour token its length', () => {
    expect(expectedLength('--r')).toBe('7px');
    expect(expectedLength('--focus-ring-extent')).toBe('4px');
  });
});
