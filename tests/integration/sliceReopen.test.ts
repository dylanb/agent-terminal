import { describe, it, expect } from 'vitest';
import { reopenSliceTransition, type SliceReopenView } from '../../src/main/sliceReopen';

// §28.4.2 / §25 — the human back-to-red decision is recorded only when the reopen lands, and before the re-entry
// is recorded so it falls in the gate's step window.
function harness(pre: SliceReopenView, after: SliceReopenView, sliceStart: string | null = 'red') {
  const log: string[] = [];
  const landed = reopenSliceTransition(
    {
      state: () => pre,
      reopen: () => {
        log.push('reopen');
        return after;
      },
      sliceStartStep: () => sliceStart,
      record: (from, to) => log.push(`record ${from.stepName}->${to.stepName}`),
    },
    () => log.push('decision'),
  );
  return { landed, log };
}

describe('reopenSliceTransition', () => {
  it('records the decision, then the re-entry, when the flow lands back at the slice start step', () => {
    const { landed, log } = harness({ status: 'in_progress', stepName: 'green' }, { status: 'in_progress', stepName: 'red' });
    expect(landed).toBe(true);
    expect(log).toEqual(['reopen', 'decision', 'record green->red']);
  });

  it('records no decision when the reopen leaves the flow away from the slice start step', () => {
    const { landed, log } = harness({ status: 'in_progress', stepName: 'green' }, { status: 'in_progress', stepName: 'green' });
    expect(landed).toBe(false);
    expect(log).toEqual(['reopen', 'record green->green']);
  });

  it('records no decision when the flow has no slice start step', () => {
    const { landed, log } = harness({ status: 'in_progress', stepName: 'green' }, { status: 'in_progress', stepName: 'red' }, null);
    expect(landed).toBe(false);
    expect(log).not.toContain('decision');
  });

  it('records no decision when the reopened flow is no longer in progress', () => {
    const { landed, log } = harness({ status: 'in_progress', stepName: 'green' }, { status: 'done', stepName: 'red' });
    expect(landed).toBe(false);
    expect(log).not.toContain('decision');
  });

  it('does not reopen, decide, or record a flow that is not in progress', () => {
    const { landed, log } = harness({ status: 'done', stepName: 'green' }, { status: 'in_progress', stepName: 'red' });
    expect(landed).toBe(false);
    expect(log).toEqual([]);
  });
});
