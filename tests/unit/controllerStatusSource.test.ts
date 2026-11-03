import { expect, it } from 'vitest';
import { createControllerStatus } from '../../src/main/controllerStatus';
import { createLoopMessages } from '../../src/main/loopMessages';
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

function stepSource(initial: { step: string; loop: string; message: ControllerLoopMessage | null; errorReason?: string }) {
  const now = { ...initial };
  const source = createControllerStatus({
    current: () => {
      const errorReason = now.loop === 'error' ? now.errorReason ?? now.message?.reason : undefined;
      return { repoKey: '/repo', flowName: 'delivery', activity: 'active', loopMessage: now.message, view: {
        stepName: now.step, status: 'in_progress', runStarted: 'started', loop: { status: now.loop, ...(errorReason ? { errorReason } : {}) },
      } };
    },
    issueTitle: async () => null,
  });
  let shown: ControllerWorkStatus | undefined;
  source.subscribe(work => { shown = work; });
  source.refresh();
  return { now, source, shown: () => shown };
}

const stalled: ControllerLoopMessage = { id: 'e1', kind: 'error', reason: 'stalled: no terminal activity' };

it('withdraws a shown loop error once the loop leaves its error status, as the terminal does', () => {
  const { now, source, shown } = stepSource({ step: 'groom-intent', loop: 'error', message: stalled });
  try {
    expect(shown()?.loopMessage).toEqual(stalled);
    now.loop = 'working';
    source.refresh();
    expect(shown()?.loopMessage ?? null).toBeNull();
  } finally { source.dispose(); }
});

it('withdraws a shown loop error when the flow moves to a new step, and shows the next error raised there', () => {
  const { now, source, shown } = stepSource({ step: 'groom-intent', loop: 'error', message: stalled });
  try {
    expect(shown()?.loopMessage).toEqual(stalled);
    now.step = 'groom';
    source.refresh();
    expect(shown()?.loopMessage ?? null).toBeNull();
    now.loop = 'working';
    source.refresh();
    expect(shown()?.loopMessage ?? null).toBeNull();
    now.message = { id: 'e2', kind: 'error', reason: 'the review turn failed' };
    source.refresh();
    expect(shown()?.loopMessage).toEqual(now.message);
  } finally { source.dispose(); }
});

it('shows a loop error first raised as the flow enters a new step', () => {
  const { now, source, shown } = stepSource({ step: 'groom-intent', loop: 'error', message: stalled });
  try {
    now.step = 'groom';
    now.loop = 'error';
    now.message = { id: 'e2', kind: 'error', reason: 'the groom turn failed' };
    source.refresh();
    expect(shown()?.loopMessage).toEqual(now.message);
  } finally { source.dispose(); }
});

it('keeps a loop error while the flow stays on its step and the loop stays in error', () => {
  const { source, shown } = stepSource({ step: 'impl-approve', loop: 'error', message: stalled });
  try {
    source.refresh();
    expect(shown()?.loopMessage).toEqual(stalled);
  } finally { source.dispose(); }
});

it('keeps an error raised while the loop was not in error, such as a failed push at an approve, after the step advances', () => {
  const pushFailed: ControllerLoopMessage = { id: 'p1', kind: 'error', reason: 'could not push fix/x to the pull request' };
  const { now, source, shown } = stepSource({ step: 'impl-approve', loop: 'awaiting-approval', message: pushFailed });
  try {
    now.step = 'finalize';
    now.loop = 'working';
    source.refresh();
    expect(shown()?.loopMessage).toEqual(pushFailed);
  } finally { source.dispose(); }
});

it('keeps a notice when the step advances and the loop leaves its error status', () => {
  const notice: ControllerLoopMessage = { id: 'n1', kind: 'notice', reason: 'nothing to commit' };
  const { now, source, shown } = stepSource({ step: 'green', loop: 'error', message: notice });
  try {
    now.step = 'green-approve';
    now.loop = 'working';
    source.refresh();
    expect(shown()?.loopMessage).toEqual(notice);
  } finally { source.dispose(); }
});

it('keeps a withdrawn loop error withdrawn on later refreshes', () => {
  const { now, source, shown } = stepSource({ step: 'groom-intent', loop: 'error', message: stalled });
  try {
    now.loop = 'working';
    source.refresh();
    source.refresh();
    now.step = 'groom';
    source.refresh();
    expect(shown()?.loopMessage ?? null).toBeNull();
  } finally { source.dispose(); }
});

it('keeps an error raised while the loop is in error that is not the loop\'s own error, such as a missing input announced on Retry', () => {
  const missingInput: ControllerLoopMessage = { id: 'w1', kind: 'error', reason: 'groom: recorded input(s) no longer available — groom-intent' };
  const { now, source, shown } = stepSource({ step: 'groom', loop: 'error', errorReason: stalled.reason, message: missingInput });
  try {
    now.loop = 'working';
    source.refresh();
    expect(shown()?.loopMessage).toEqual(missingInput);
  } finally { source.dispose(); }
});

it('withdraws the loop\'s own error when its reason was too long to publish whole', () => {
  const reason = `stalled: ${'x'.repeat(20 * 1024)}`;
  const messages = createLoopMessages(() => {});
  messages.post('error', reason);
  const { now, source, shown } = stepSource({ step: 'groom-intent', loop: 'error', errorReason: reason, message: messages.current() });
  try {
    expect(shown()?.loopMessage?.kind).toBe('error');
    now.loop = 'working';
    source.refresh();
    expect(shown()?.loopMessage ?? null).toBeNull();
  } finally { source.dispose(); }
});
