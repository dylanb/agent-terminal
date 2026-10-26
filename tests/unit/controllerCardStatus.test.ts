import { describe, expect, it } from 'vitest';
import { attentionText, attentionUpdate, cardStatus, statusSummary } from '../../src/renderer/src/controllerCardStatus';
import { CONTROLLER_OVERSIZED_STATUS_TEXT } from '../../src/shared/controllerStatus';
import { STATUS_CASES, SUMMARY_LABELS, statusTerminal } from '../helpers/controllerStatusFixture';

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

  it('counts the terminals under each header summary label, in order, with the status class each label is painted in', () => {
    const cases = Object.values(STATUS_CASES);
    const paintedAs = { errors: 'error', 'need a human': 'needs-human', idle: 'idle', working: 'working' } as const;
    expect(statusSummary(cases.map(c => c.terminal))).toEqual(SUMMARY_LABELS.map(label => ({
      label, statusClass: paintedAs[label], count: cases.filter(c => c.summary === label).length,
    })));
  });
});

describe('controller attention text', () => {
  it('words a terminal\'s attention and error as its card words them, each condition\'s title before its reasons', () => {
    expect(attentionText(statusTerminal({ attention: { status: 'error', reasons: ['Check failed', 'Lint failed'] }, error: { reason: 'Broken build' } })))
      .toBe('Human needed: error. Check failed. Lint failed. Error. Broken build');
  });

  it('is empty when nothing needs attention, and the oversized-status text when the status could not be read', () => {
    const unread = statusTerminal();
    expect([attentionText(statusTerminal()), attentionText({ ...unread, work: { ...unread.work, unavailableReason: 'message-too-large' } })])
      .toEqual(['', CONTROLLER_OVERSIZED_STATUS_TEXT]);
  });
});

describe('controller attention announcement', () => {
  it('announces nothing when attention is unchanged, the new text when it changes, and which kind of clearing happened', () => {
    const blocked = attentionText(statusTerminal({ attention: { status: 'complete', reasons: ['Review required'] } }));
    const unread = statusTerminal();
    const oversized = attentionText({ ...unread, work: { ...unread.work, unavailableReason: 'message-too-large' } });
    expect([attentionUpdate('', ''), attentionUpdate(blocked, blocked), attentionUpdate('', blocked), attentionUpdate(blocked, ''), attentionUpdate(oversized, '')])
      .toEqual([undefined, undefined, blocked, 'Attention and error cleared', 'Status available: no attention or error reported']);
  });
});
