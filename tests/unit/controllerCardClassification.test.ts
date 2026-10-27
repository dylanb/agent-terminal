// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { cardStatus, statusSummary } from '../../src/shared/controllerCardClassification';
import { STATUS_CASES, SUMMARY_LABELS } from '../helpers/controllerStatusFixture';

describe('controller card classification', () => {
  it('gives every terminal the status text, class and summary label of the first matching status row', () => {
    const wrong = Object.entries(STATUS_CASES).flatMap(([key, { terminal, text, statusClass, summary }]) => {
      const actual = cardStatus(terminal);
      const got = { text: actual.text, statusClass: actual.statusClass, summary: actual.summary };
      return JSON.stringify(got) === JSON.stringify({ text, statusClass, summary })
        ? [] : [`${key}: got ${JSON.stringify(got)}, expected ${JSON.stringify({ text, statusClass, summary })}`];
    });
    expect(wrong).toEqual([]);
  });

  it('counts the terminals under each header summary label, in order, with the status class each label is painted in', () => {
    const cases = Object.values(STATUS_CASES);
    const paintedAs = { errors: 'error', 'need a human': 'needs-human', idle: 'idle', working: 'working' } as const;
    expect(statusSummary(cases.map(c => c.terminal))).toEqual(SUMMARY_LABELS.map(label => ({
      label, statusClass: paintedAs[label], count: cases.filter(c => c.summary === label).length,
    })));
  });
});
