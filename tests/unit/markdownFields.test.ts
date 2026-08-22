import { describe, it, expect } from 'vitest';
import { stripLeadingBullet, fieldValue } from '../../src/shared/markdownFields';

// The shared linear-scan field primitives (§27.5 round report + §28.5.5 phase result). Every bullet glyph the
// grammars tolerate is pinned HERE, once — so a deleted branch fails a test rather than silently narrowing what
// both agent-output grammars recognize.

describe('markdownFields — bullet-tolerant field recognition', () => {
  it('recognizes a field under every tolerated bullet glyph (and none)', () => {
    for (const line of [
      'outcome: passed',
      '- outcome: passed',
      '* outcome: passed',
      '+ outcome: passed',
      '1. outcome: passed',
      '1) outcome: passed',
      '  -   outcome: passed', // leading whitespace + spaced bullet
    ]) {
      expect(fieldValue(line, 'outcome')).toBe('passed');
    }
  });

  it('returns null when the line is not the named field', () => {
    expect(fieldValue('disposition: fixed', 'outcome')).toBeNull(); // different label
    expect(fieldValue('some prose without a colon', 'outcome')).toBeNull();
    expect(fieldValue('# heading', 'outcome')).toBeNull();
  });

  it('trims the value but never normalizes it', () => {
    expect(fieldValue('outcome:   failed-assertion  ', 'outcome')).toBe('failed-assertion');
    expect(fieldValue('outcome: Passed', 'outcome')).toBe('Passed'); // case preserved — membership is the caller's
  });

  it('stripLeadingBullet removes only a leading list marker, leaving other text intact', () => {
    expect(stripLeadingBullet('- item')).toBe('item');
    expect(stripLeadingBullet('12) item')).toBe('item');
    expect(stripLeadingBullet('not-a-bullet')).toBe('not-a-bullet'); // a dash mid-token is not a marker
    expect(stripLeadingBullet('v1.2 release')).toBe('v1.2 release'); // leading non-digit → no marker stripped
    expect(stripLeadingBullet('3. numbered')).toBe('numbered'); // `<n>.` IS an ordered-list marker
  });
});
