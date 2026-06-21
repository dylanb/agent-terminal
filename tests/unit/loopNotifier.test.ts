import { describe, expect, it, vi } from 'vitest';
import { createLoopNotifier, type LoopNotifierDeps, type LoopNotifyOpts } from '../../src/main/loopNotifier';
import type { FlowLoopView, FlowStateView } from '../../src/shared/ipc';

// §24.2.3 T4 — the OS attention notification decision. Behavior under test = whether observing a flow
// view raises / dedups / clears the notification, and what activation does. The notification surface
// is injected (CLAUDE.md permits spying it — it is not the emulator/PTY), so these assert observable
// outputs: notify calls, their payload, the close calls, and the activation side effects. The
// occurrence identity is per-repo (`repoKey, status, iteration`) — the loop is repo-scoped (§16.3).

const REPO = '/repo';

function loopView(loop: Partial<FlowLoopView> & { status: string; iteration: number }): FlowStateView {
  return {
    stepName: 'build',
    steps: ['build'],
    position: 1,
    total: 1,
    status: 'in_progress',
    loop: { pr: null, branch: null, ready: false, humanNeeded: true, ...loop },
  };
}
const NON_LOOP: FlowStateView = { stepName: 's', steps: ['s'], position: 1, total: 1, status: 'in_progress' };

function harness(over: Partial<LoopNotifierDeps> = {}) {
  const notify = vi.fn<(o: LoopNotifyOpts) => () => void>(() => () => {});
  const focusWindow = vi.fn();
  const reveal = vi.fn();
  const deps: LoopNotifierDeps = {
    isFocused: () => false,
    notify,
    focusWindow,
    reveal,
    ...over,
  };
  return { notifier: createLoopNotifier(deps), notify, focusWindow, reveal };
}

describe('createLoopNotifier (§24.2.3 T4)', () => {
  it('raises an OS notification on a distinct human-needed entry while unfocused', () => {
    const { notifier, notify } = harness();
    notifier.observe(REPO, loopView({ status: 'awaiting-human-pr-approval', iteration: 9 }));
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0].body).toContain('awaiting-human-pr-approval');
    expect(notify.mock.calls[0][0].body).toContain('9');
  });

  it('does not raise when the window is focused', () => {
    const { notifier, notify } = harness({ isFocused: () => true });
    notifier.observe(REPO, loopView({ status: 'awaiting-human-pr-approval', iteration: 9 }));
    expect(notify).not.toHaveBeenCalled();
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

  it('raises the initial human-needed entry seen at start (no prior signalled occurrence) when unfocused', () => {
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

  it('closes the showing notification on a non-human-needed view', () => {
    const close = vi.fn();
    const { notifier } = harness({ notify: () => close });
    notifier.observe(REPO, loopView({ status: 'awaiting-human-pr-approval', iteration: 9 }));
    notifier.observe(REPO, loopView({ status: 'impl-draft', iteration: 9, humanNeeded: false }));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('closes the showing notification on a null mirror (no loop)', () => {
    const close = vi.fn();
    const { notifier } = harness({ notify: () => close });
    notifier.observe(REPO, loopView({ status: 'awaiting-human-pr-approval', iteration: 9 }));
    notifier.observe(REPO, NON_LOOP);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('closes the prior notification before raising a distinct human-needed entry', () => {
    const close = vi.fn();
    const { notifier } = harness({ notify: () => close });
    notifier.observe(REPO, loopView({ status: 'awaiting-human-pr-approval', iteration: 9 }));
    notifier.observe(REPO, loopView({ status: 'awaiting-human-impl-triage', iteration: 9 }));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('does not close one repo\'s notification when a different, non-loop repo is observed', () => {
    const close = vi.fn();
    const { notifier } = harness({ notify: () => close });
    notifier.observe('/repoA', loopView({ status: 'awaiting-human-pr-approval', iteration: 9 }));
    notifier.observe('/repoB', NON_LOOP);
    expect(close).not.toHaveBeenCalled();
  });

  it('focuses the window and emits the reveal signal when the notification is activated', () => {
    const { notifier, notify, focusWindow, reveal } = harness();
    notifier.observe(REPO, loopView({ status: 'awaiting-human-pr-approval', iteration: 9 }));
    notify.mock.calls[0][0].onActivate();
    expect(focusWindow).toHaveBeenCalledTimes(1);
    expect(reveal).toHaveBeenCalledTimes(1);
  });
});
