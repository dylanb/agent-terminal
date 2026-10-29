// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { cardCounts, cardStatus, statusSummary } from '../../src/shared/controllerCardClassification';
import { directoryCards } from '../../src/shared/controllerCards';
import { directoryConflictFixture, distinctAttentionMix, STATUS_CASES, SUMMARY_LABELS } from '../helpers/controllerStatusFixture';

describe('controller card classification', () => {
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
