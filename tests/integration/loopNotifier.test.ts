import { describe, expect, it, vi } from 'vitest';
import { createLoopNotifier, type LoopNotifyOpts } from '../../src/main/loopNotifier';
import type { FlowLoopView, FlowStateView } from '../../src/shared/ipc';

// §24.2.3 T4 — the OS-notification decision is engine-neutral: the notifier observes a FlowStateView and
// keys only on the loop view's human-needed state and its (status, iteration) occurrence identity, knowing
// nothing about which engine produced it. These fixtures reproduce each precondition as a §27 loop view
// directly (the §26 state.yaml→deriveLoopView derivation is gone); only the OS-notification surface is spied.

const REPO = '/repo';
const BASE: FlowStateView = { stepName: 'build', steps: ['build'], position: 1, total: 1, status: 'in_progress' };

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

  // The app hosts the agent, so the window is almost always focused at the instant the loop stops for
  // the human. A raise skipped for focus must stay PENDING, not count as signalled — otherwise walking
  // away from the app is exactly the moment the notification is guaranteed never to arrive.
  it('raises when the user leaves the app, for an entry that arrived while the window was focused', () => {
    const { notifier, notify, setFocused } = spyNotifier(true);
    notifier.observe(REPO, view('awaiting-human-pr-approval', 9, true));
    expect(notify).not.toHaveBeenCalled();
    setFocused(false);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('does not re-raise an already-raised entry when the window is focused and left again', () => {
    const { notifier, notify, setFocused } = spyNotifier(false);
    notifier.observe(REPO, view('awaiting-human-pr-approval', 9, true));
    setFocused(true);
    setFocused(false);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('never raises for an entry the loop resolved while the window was focused', () => {
    const { notifier, notify, setFocused } = spyNotifier(true);
    notifier.observe(REPO, view('awaiting-human-pr-approval', 9, true));
    notifier.observe(REPO, view('working', 10, false)); // the human answered in-app; the loop moved on
    setFocused(false);
    expect(notify).not.toHaveBeenCalled();
  });

  it('clears the notification when the step leaves the loop view, raising nothing in its place', () => {
    const close = vi.fn();
    const notify = vi.fn<(o: LoopNotifyOpts) => () => void>(() => close);
    const notifier = createLoopNotifier({
      isFocused: () => false,
      onFocusChanged: () => {},
      notify,
      focusWindow: vi.fn(),
      reveal: vi.fn(),
    });
    notifier.observe(REPO, view('awaiting-human-pr-approval', 9, true));
    // A FlowStateView with NO loop member — the step is not loop-bound / the provider is not consulted — is
    // the precondition that takes observe's `!loop` clear branch. An unresolvable §27 def would instead be a
    // human-needed error view and raise a SECOND notification, so the negative below is what keeps this honest.
    notifier.observe(REPO, { ...BASE });
    expect(close).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
