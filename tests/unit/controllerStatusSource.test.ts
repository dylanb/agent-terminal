import { expect, it } from 'vitest';
import { createControllerStatus } from '../../src/main/controllerStatus';
import type { ControllerLoopMessage, ControllerWorkStatus } from '../../src/shared/ipc';

it.each([0, Infinity, Number.MAX_SAFE_INTEGER + 1])('keeps known work visible when persisted ticket %s is invalid', number => {
  const source = createControllerStatus({
    current: () => ({ repoKey: '/repo', flowName: 'delivery', activity: 'active', loopMessage: null, view: {
      stepName: 'work', status: 'in_progress', runStarted: 'started', refs: { ticket: number },
    } }),
    issueTitle: async () => null,
  });
  let shown: ControllerWorkStatus | undefined;
  source.subscribe(work => { shown = work; });
  try {
    source.refresh();
    expect(shown).toMatchObject({ flow: { availability: 'known', name: 'delivery', assignment: 'assigned' }, activity: 'active', ticket: { availability: 'unavailable' } });
  } finally { source.dispose(); }
});

it.each(['Issue title', ''])('accepts only the required flow facts and a title string (%j)', async title => {
  const source = createControllerStatus({
    current: () => ({ repoKey: '/repo', flowName: 'delivery', activity: 'active', loopMessage: null, view: {
      stepName: 'work', status: 'in_progress', runStarted: 'started', refs: { ticket: 219 },
      loop: { status: 'awaiting-approval', humanNeeded: true, verdictReason: 'Review required' },
    } }),
    issueTitle: async () => title,
  });
  let shown: ControllerWorkStatus | undefined;
  source.subscribe(work => { shown = work; });
  try {
    source.refresh();
    await expect.poll(() => shown?.ticket).toEqual({ availability: 'known', number: 219, title: { availability: 'known', text: title } });
    expect(shown?.attention).toEqual({ status: 'awaiting-approval', reasons: ['Review required'] });
  } finally { source.dispose(); }
});

it('gives each status subscriber its own snapshot, including late subscribers', () => {
  const source = createControllerStatus({
    current: () => ({ repoKey: '/repo', flowName: 'delivery', activity: 'active', loopMessage: null, view: {
      stepName: 'work', status: 'in_progress', runStarted: 'started',
      loop: { status: 'awaiting-approval', humanNeeded: true, verdictReason: 'Review required' },
    } }),
    issueTitle: async () => null,
  });
  source.subscribe(work => { work.attention?.reasons.push('Subscriber edit'); });
  let observed: ControllerWorkStatus | undefined;
  source.subscribe(work => { observed = work; });
  try {
    source.refresh();
    expect(observed?.attention?.reasons).toEqual(['Review required']);
    observed!.attention!.reasons.push('Another edit');
    source.subscribe(work => { expect(work.attention?.reasons).toEqual(['Review required']); });
  } finally { source.dispose(); }
});

it('publishes the latest loop message beside the flow\'s own error, and none when there is none', () => {
  let loopMessage: ControllerLoopMessage | null = { id: 'm1', kind: 'notice', reason: 'nothing to commit' };
  const source = createControllerStatus({
    current: () => ({ repoKey: '/repo', flowName: 'delivery', activity: 'quiet', loopMessage, view: {
      stepName: 'work', status: 'in_progress', runStarted: 'started', error: 'step failed',
    } }),
    issueTitle: async () => null,
  });
  let shown: ControllerWorkStatus | undefined;
  source.subscribe(work => { shown = work; });
  try {
    source.refresh();
    expect([shown?.error, shown?.loopMessage]).toEqual([{ reason: 'step failed' }, { id: 'm1', kind: 'notice', reason: 'nothing to commit' }]);
    loopMessage = null;
    source.refresh();
    expect(shown?.loopMessage).toBeNull();
  } finally { source.dispose(); }
});
