import { describe, expect, it, vi } from 'vitest';
import { createLoopNotifier, type LoopNotifyOpts } from '../../src/main/loopNotifier';
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
  function spyNotifier(focused = false) {
    const notify = vi.fn<(o: LoopNotifyOpts) => () => void>(() => () => {});
    let isFocused = focused;
    const listeners: (() => void)[] = [];
    const notifier = createLoopNotifier({
      isFocused: () => isFocused,
      onFocusChanged: (listener) => listeners.push(listener),
      notify,
      focusWindow: vi.fn(),
      reveal: vi.fn(),
    });
    const setFocused = (next: boolean): void => {
      isFocused = next;
      for (const listener of listeners) listener();
    };
    return { notify, notifier, setFocused };
  }

  it('raises on a human-needed gate view when unfocused', () => {
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

  it('publishes the human stop before any focus loss and does not replay it on blur', () => {
    const { notifier, notify, setFocused } = spyNotifier(true);
    notifier.observe(REPO, view('awaiting-human-pr-approval', 9, true));
    expect.soft(notify.mock.calls.map(([message]) => message.body)).toEqual(['awaiting-human-pr-approval · iter 9']);
    setFocused(false);
    expect(notify.mock.calls.map(([message]) => message.body)).toEqual(['awaiting-human-pr-approval · iter 9']);
  });

  it('does not re-raise an already-raised entry when the window is focused and left again', () => {
    const { notifier, notify, setFocused } = spyNotifier(false);
    notifier.observe(REPO, view('awaiting-human-pr-approval', 9, true));
    setFocused(true);
    setFocused(false);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('publishes even a stop resolved before focus changes', () => {
    const { notifier, notify, setFocused } = spyNotifier(true);
    notifier.observe(REPO, view('awaiting-human-pr-approval', 9, true));
    notifier.observe(REPO, view('working', 10, false));
    setFocused(false);
    expect(notify.mock.calls.map(([message]) => message.body)).toEqual(['awaiting-human-pr-approval · iter 9']);
  });
});
