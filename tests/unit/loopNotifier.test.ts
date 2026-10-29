import { describe, expect, it, vi } from 'vitest';
import { createLoopNotifier } from '../../src/main/loopNotifier';
import type { NotificationCondition } from '../../src/shared/controllerProtocol';
import type { FlowLoopView, FlowStateView } from '../../src/shared/ipc';

const REPO = '/repo';

function loopView(loop: Partial<FlowLoopView> & { status: string; iteration: number }): FlowStateView {
  return {
    stepName: 'build', runStarted: 'never-started' as const,
    steps: ['build'],
    position: 1,
    total: 1,
    status: 'in_progress',
    loop: { pr: null, branch: null, ready: false, humanNeeded: true, ...loop },
  };
}

function harness() {
  const notify = vi.fn<(notification: NotificationCondition) => void>();
  const notifier = createLoopNotifier();
  notifier.subscribe(notify);
  return { notifier, notify };
}

describe('createLoopNotifier (§24.2.3 T4)', () => {
  it('publishes a notification on a distinct human-needed entry immediately', () => {
    const { notifier, notify } = harness();
    notifier.observe(REPO, loopView({ status: 'awaiting-human-pr-approval', iteration: 9 }));
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0].message).toContain('awaiting-human-pr-approval');
    expect(notify.mock.calls[0][0].message).toContain('9');
  });

  it('omits the iteration segment from the body when no round has run (a §27 run-less failure)', () => {
    const { notifier, notify } = harness();
    const runLessFailure: FlowStateView = {
      stepName: 'plan', runStarted: 'never-started' as const,
      steps: ['plan'],
      position: 1,
      total: 1,
      status: 'in_progress',
      loop: { status: 'error', pr: null, branch: null, ready: false, humanNeeded: true },
    };
    notifier.observe(REPO, runLessFailure);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0].message).toContain('error');
    expect(notify.mock.calls[0][0].message).not.toContain('iter');
  });

  it('bounds length and strips control characters from a foreign status before publication', () => {
    const { notifier, notify } = harness();
    const hostile = `awaiting-human\n${'x'.repeat(500)}`;
    notifier.observe(REPO, loopView({ status: hostile, iteration: 9 }));
    const { message } = notify.mock.calls[0][0];
    expect(message).not.toContain('\n');
    expect(message.length).toBeLessThanOrEqual(100);
  });

  it('publishes immediately without a focus dependency', () => {
    const { notifier, notify } = harness();
    notifier.observe(REPO, loopView({ status: 'awaiting-human-pr-approval', iteration: 9 }));
    expect(notify.mock.calls.map(([message]) => message.message)).toEqual(['awaiting-human-pr-approval · iter 9']);
  });

  it('does not raise for a non-human-needed view', () => {
    const { notifier, notify } = harness();
    notifier.observe(REPO, loopView({ status: 'impl-draft', iteration: 9, humanNeeded: false }));
    expect(notify).not.toHaveBeenCalled();
  });

  it('does not re-raise on a repeated (status, iteration) occurrence', () => {
    const { notifier, notify } = harness();
    const v = loopView({ status: 'awaiting-human-pr-approval', iteration: 9 });
    notifier.observe(REPO, v);
    notifier.observe(REPO, v);
    notifier.observe(REPO, loopView({ status: 'awaiting-human-pr-approval', iteration: 9 }));
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('re-raises when the human-needed status changes within the same iteration', () => {
    const { notifier, notify } = harness();
    notifier.observe(REPO, loopView({ status: 'awaiting-human-pr-approval', iteration: 9 }));
    notifier.observe(REPO, loopView({ status: 'awaiting-human-impl-triage', iteration: 9 }));
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('re-raises when the iteration advances into a human-needed state', () => {
    const { notifier, notify } = harness();
    notifier.observe(REPO, loopView({ status: 'awaiting-human-pr-approval', iteration: 9 }));
    notifier.observe(REPO, loopView({ status: 'awaiting-human-pr-approval', iteration: 10 }));
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('raises the initial human-needed entry seen at start (no prior signalled occurrence)', () => {
    const { notifier, notify } = harness();
    notifier.observe(REPO, loopView({ status: 'awaiting-human-pr-approval', iteration: 1 }));
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('raises again when a different repo presents the same (status, iteration) — a distinct loop', () => {
    const { notifier, notify } = harness();
    notifier.observe('/repoA', loopView({ status: 'awaiting-human-pr-approval', iteration: 9 }));
    notifier.observe('/repoB', loopView({ status: 'awaiting-human-pr-approval', iteration: 9 }));
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('publishes each repository stop in observation order', () => {
    const { notifier, notify } = harness();
    notifier.observe('/repoA', loopView({ status: 'awaiting-human-pr-approval', iteration: 9 }));
    notifier.observe('/repoB', loopView({ status: 'error', iteration: 3 }));
    expect(notify.mock.calls.map(([notification]) => notification.message)).toEqual([
      'awaiting-human-pr-approval · iter 9', 'error · iter 3',
    ]);
  });

  it('does not re-fire on a same-repo return visit after a detour to another repo (per-repo dedup)', () => {
    // §16.3: dedup is keyed per repo. cd A→B→A at the unchanged occurrence must stay deduped for A — a
    // single global slot would be overwritten by B and treat A's return as a fresh, distinct entry.
    const { notifier, notify } = harness();
    const occ = { status: 'awaiting-human-pr-approval', iteration: 9 };
    notifier.observe('/repoA', loopView(occ));
    notifier.observe('/repoB', loopView(occ));
    notifier.observe('/repoA', loopView(occ));
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('unsubscribed consumers receive no later arrivals', () => {
    const notifier = createLoopNotifier();
    const received: NotificationCondition[] = [];
    const stop = notifier.subscribe(notification => received.push(notification));
    notifier.observe(REPO, loopView({ status: 'error', iteration: 9 }));
    stop();
    notifier.observe(REPO, loopView({ status: 'complete', iteration: 10 }));
    expect(received.map(notification => notification.message)).toEqual(['error · iter 9']);
  });

  it('a failed subscriber cannot interrupt other consumers or current work', () => {
    const notifier = createLoopNotifier();
    notifier.subscribe(() => { throw new Error('controller disconnected'); });
    const received: NotificationCondition[] = [];
    notifier.subscribe(notification => received.push(notification));
    expect.soft(() => notifier.observe(REPO, loopView({ status: 'error', iteration: 9 }))).not.toThrow();
    expect.soft(received.map(notification => notification.message)).toEqual(['error · iter 9']);
    expect.soft(notifier.current()).toEqual(received[0]);
    expect(() => notifier.observe(REPO, loopView({ status: 'working', iteration: 9, humanNeeded: false }))).not.toThrow();
    expect(notifier.current()).toBeNull();
  });

});

// §27.9.1 N9b.5(e) (#137) — a view carrying `autoGate` that stops needing a human ends that stop, so the next stop notifies.
describe('createLoopNotifier — distinct auto-gate stops (§27.9.1)', () => {
  const DECIDING = { deciding: true, hung: false, haltReasons: [] };
  const HALTED = { deciding: false, hung: false, haltReasons: [{ reason: 'stop-for-a-human' as const }] };

  it('a human-needed stop, then a deciding gate, then another human-needed stop with the same status and iteration notifies twice', () => {
    const { notifier, notify } = harness();
    notifier.observe(REPO, loopView({ status: 'complete', iteration: 1, autoGate: HALTED }));
    notifier.observe(REPO, loopView({ status: 'complete', iteration: 1, humanNeeded: false, autoGate: DECIDING }));
    notifier.observe(REPO, loopView({ status: 'complete', iteration: 1, autoGate: HALTED }));
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('the same human-needed auto-gate stop pushed three times notifies once', () => {
    const { notifier, notify } = harness();
    for (let i = 0; i < 3; i += 1) notifier.observe(REPO, loopView({ status: 'complete', iteration: 1, autoGate: HALTED }));
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('pinning: two stops of a run with no auto step sharing status and iteration, a working view between, notify once (AC7)', () => {
    const { notifier, notify } = harness();
    notifier.observe(REPO, loopView({ status: 'complete', iteration: 1 }));
    notifier.observe(REPO, loopView({ status: 'working', iteration: 1, humanNeeded: false }));
    notifier.observe(REPO, loopView({ status: 'complete', iteration: 1 }));
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

it('a continuing per-step human stop publishes once despite status changes', () => {
  const { notifier, notify } = harness();
  const autoGate = { deciding: false, hung: false, haltReasons: [{ reason: 'stop-for-a-human' as const }] };
  notifier.observe(REPO, loopView({ status: 'error', iteration: 1, autoGate }));
  notifier.observe(REPO, loopView({ status: 'complete', iteration: 1, autoGate }));
  expect(notify.mock.calls.map(([message]) => message.message)).toEqual(['error · iter 1']);
});
