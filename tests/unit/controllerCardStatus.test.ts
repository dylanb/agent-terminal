import { describe, expect, it } from 'vitest';
import { cardStatus } from '../../src/shared/controllerCardStatus';
import { STATUS_CASES } from '../helpers/controllerStatusFixture';

describe('controller card status', () => {
  it('gives every terminal the status text, class and summary label of the first matching status row', () => {
    const wrong = Object.entries(STATUS_CASES).flatMap(([key, { terminal, text, statusClass, summary }]) => {
      const actual = cardStatus(terminal);
      const got = { text: actual.text, statusClass: actual.statusClass, summary: actual.summary };
      return JSON.stringify(got) === JSON.stringify({ text, statusClass, summary })
        ? [] : [`${key}: got ${JSON.stringify(got)}, expected ${JSON.stringify({ text, statusClass, summary })}`];
    });
    expect(wrong).toEqual([]);
  });
});
