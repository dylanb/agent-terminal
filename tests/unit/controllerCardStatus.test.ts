import { directoryCards } from '../../src/shared/controllerCards';
import { describe, expect, it } from 'vitest';
import { attentionText, attentionUpdate, cardCounts, cardStatus, statusSummary } from '../../src/shared/controllerCardStatus';
import { CONTROLLER_OVERSIZED_STATUS_TEXT } from '../../src/shared/controllerStatus';
import { directoryConflictFixture, distinctAttentionMix, STATUS_CASES, SUMMARY_LABELS, statusTerminal } from '../helpers/controllerStatusFixture';

describe('controller card status', () => {
  it('gives every terminal the status text, class and summary label of the first matching status row', () => {
    const wrong = Object.entries(STATUS_CASES).flatMap(([key, { terminal, text, statusClass, summary }]) => {
      const actual = cardStatus(directoryCards([terminal])[0]);
      const got = { text: actual.text, statusClass: actual.statusClass, summary: actual.summary };
      return JSON.stringify(got) === JSON.stringify({ text, statusClass, summary })
        ? [] : [`${key}: got ${JSON.stringify(got)}, expected ${JSON.stringify({ text, statusClass, summary })}`];
    });
    expect(wrong).toEqual([]);
  });

  it('counts the terminals under each header summary label, in order, with the status class each label is painted in', () => {
    const cases = Object.values(STATUS_CASES);
    const paintedAs = { errors: 'error', 'need a human': 'needs-human', idle: 'idle', working: 'working' } as const;
    expect(statusSummary(cases.map(c => directoryCards([c.terminal])[0]))).toEqual(SUMMARY_LABELS.map(label => ({
      label, statusClass: paintedAs[label], count: cases.filter(c => c.summary === label).length,
    })));
  });
});

describe('controller card counts', () => {
  it('counts every card, the connected ones and the disconnected ones, a shared directory and a re-registered one once each', () => {
    const mix = distinctAttentionMix();
    const { members, unrelated } = directoryConflictFixture();
    const rejoined = [
      { id: 'rejoined-old', launchDirectory: '/rejoined', repositoryRoot: null, status: 'disconnected' as const },
      { id: 'rejoined-new', launchDirectory: '/rejoined', repositoryRoot: null },
    ];
    const conflict = [...members, unrelated, ...rejoined, STATUS_CASES.disconnected.terminal, STATUS_CASES['disconnected-with-error'].terminal];
    expect({ mix: cardCounts(directoryCards(mix.terminals)), conflict: cardCounts(directoryCards(conflict)) }).toEqual({
      mix: { total: mix.counts.total, connected: mix.counts.connected, disconnected: mix.counts.disconnected },
      conflict: { total: 5, connected: 3, disconnected: 2 },
    });
  });
});

describe('controller attention text', () => {
  it('words a terminal\'s attention and error as its card words them, each condition\'s title before its reasons', () => {
    expect(attentionText(statusTerminal({ attention: { status: 'error', reasons: ['Check failed', 'Lint failed'] }, error: { reason: 'Broken build' } }).work))
      .toBe('Human needed: error. Check failed. Lint failed. Error. Broken build');
  });

  it('is empty when nothing needs attention, and the oversized-status text when the status could not be read', () => {
    const unread = statusTerminal();
    expect([attentionText(statusTerminal().work), attentionText({ ...unread.work, unavailableReason: 'message-too-large' })])
      .toEqual(['', CONTROLLER_OVERSIZED_STATUS_TEXT]);
  });
});

describe('controller attention announcement', () => {
  it('announces nothing when attention is unchanged, the new text when it changes, and which kind of clearing happened', () => {
    const blocked = attentionText(statusTerminal({ attention: { status: 'complete', reasons: ['Review required'] } }).work);
    const unread = statusTerminal();
    const oversized = attentionText({ ...unread.work, unavailableReason: 'message-too-large' });
    expect([attentionUpdate('', ''), attentionUpdate(blocked, blocked), attentionUpdate('', blocked), attentionUpdate(blocked, ''), attentionUpdate(oversized, '')])
      .toEqual([undefined, undefined, blocked, 'Attention and error cleared', 'Status available: no attention or error reported']);
  });
});
