import { describe, expect, it, vi } from 'vitest';
import { createLoopNotifier } from '../../src/main/loopNotifier';
import type { NotificationCondition } from '../../src/shared/controllerProtocol';
import type { FlowLoopView, FlowStateView } from '../../src/shared/ipc';

const REPO = '/repo';
const BASE: FlowStateView = { stepName: 'build', runStarted: 'never-started' as const, steps: ['build'], position: 1, total: 1, status: 'in_progress' };

const view = (status: string, iteration: number | undefined, humanNeeded: boolean): FlowStateView => {
  const loop: FlowLoopView = {
    status,
    pr: 179,
    branch: 'b',
    ready: false,
    actionable: false,
    humanNeeded,
    ...(iteration === undefined ? {} : { iteration }),
  };
  return { ...BASE, loop };
};

describe('loop notifier driven from a §27 loop view (§24.2.3 T4)', () => {
  function spyNotifier() {
    const notify = vi.fn<(notification: NotificationCondition) => void>();
    const notifier = createLoopNotifier();
    notifier.subscribe(notify);
    return { notify, notifier };
  }

  it('raises on a human-needed gate view', () => {
    const { notifier, notify } = spyNotifier();
    notifier.observe(REPO, view('awaiting-human-pr-approval', 9, true));
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('does not raise on a terminal hand-off view', () => {
    const { notifier, notify } = spyNotifier();
    notifier.observe(REPO, view('awaiting-team-review', 9, false));
    expect(notify).not.toHaveBeenCalled();
  });

  it('re-raises when a distinct human-needed occurrence arrives in a later round', () => {
    const { notifier, notify } = spyNotifier();
    // Two DISTINCT §27 human-needed occurrences — the §27 vocabulary reaches human-needed only via `error`
    // or a gate — so the shared occurrence identity (status, iteration) separates them and both raise.
    notifier.observe(REPO, view('error', 9, true));
    notifier.observe(REPO, view('awaiting-human-impl-triage', 11, true));
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('publishes the human stop immediately', () => {
    const { notifier, notify } = spyNotifier();
    notifier.observe(REPO, view('awaiting-human-pr-approval', 9, true));
    expect(notify.mock.calls.map(([message]) => message.message)).toEqual(['awaiting-human-pr-approval · iter 9']);
  });

  it('does not re-raise an unchanged human-needed observation', () => {
    const { notifier, notify } = spyNotifier();
    notifier.observe(REPO, view('awaiting-human-pr-approval', 9, true));
    notifier.observe(REPO, view('awaiting-human-pr-approval', 9, true));
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('retains delivery of a stop resolved by the next observation', () => {
    const { notifier, notify } = spyNotifier();
    notifier.observe(REPO, view('awaiting-human-pr-approval', 9, true));
    notifier.observe(REPO, view('working', 10, false));
    expect(notify.mock.calls.map(([message]) => message.message)).toEqual(['awaiting-human-pr-approval · iter 9']);
  });
});
