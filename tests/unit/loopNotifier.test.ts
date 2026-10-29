import { describe, expect, it, vi } from 'vitest';
import { createLoopNotifier, type LoopNotifierDeps, type LoopNotifyOpts } from '../../src/main/loopNotifier';
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

function harness(over: Partial<LoopNotifierDeps> = {}) {
  const notify = vi.fn<(o: LoopNotifyOpts) => () => void>(() => () => {});
  const focusWindow = vi.fn();
  const reveal = vi.fn();
  const deps: LoopNotifierDeps = {
    isFocused: () => false,
    onFocusChanged: () => {},
    notify,
    focusWindow,
    reveal,
    ...over,
  };
  return { notifier: createLoopNotifier(deps), notify, focusWindow, reveal };
}

describe('createLoopNotifier (§24.2.3 T4)', () => {
  it('publishes a notification on a distinct human-needed entry while unfocused', () => {
    const { notifier, notify } = harness();
    notifier.observe(REPO, loopView({ status: 'awaiting-human-pr-approval', iteration: 9 }));
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0].body).toContain('awaiting-human-pr-approval');
    expect(notify.mock.calls[0][0].body).toContain('9');
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
    expect(notify.mock.calls[0][0].body).toContain('error');
    expect(notify.mock.calls[0][0].body).not.toContain('iter');
  });

  it('bounds length and strips control characters from a foreign status before publication', () => {
    // CWE-117: `status` is read from an arbitrary repo's untrusted `.agent-loop/state.yaml` (§16.3),
    // so it must reach the OS notification sink length-bounded and free of control characters.
    const { notifier, notify } = harness();
    const hostile = `awaiting-human\n${'x'.repeat(500)}`;
    notifier.observe(REPO, loopView({ status: hostile, iteration: 9 }));
    const { body } = notify.mock.calls[0][0];
    expect(body).not.toContain('\n');
    expect(body.length).toBeLessThanOrEqual(100);
  });

  it('publishes immediately when the window is focused', () => {
    const { notifier, notify } = harness({ isFocused: () => true });
    notifier.observe(REPO, loopView({ status: 'awaiting-human-pr-approval', iteration: 9 }));
    expect(notify.mock.calls.map(([message]) => message.body)).toEqual(['awaiting-human-pr-approval · iter 9']);
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

  it('publishes each repository stop before blur, without replaying it on focus changes', () => {
    let focused = true;
    const listeners: (() => void)[] = [];
    const { notifier, notify } = harness({
      isFocused: () => focused,
      onFocusChanged: listener => listeners.push(listener),
    });
    notifier.observe('/repoA', loopView({ status: 'awaiting-human-pr-approval', iteration: 9 }));
    notifier.observe('/repoB', loopView({ status: 'error', iteration: 3 }));
    const delivered = () => notify.mock.calls.map(([message]) => ({ repo: message.repoKey, body: message.body }));
    const expected = [
      { repo: '/repoA', body: 'awaiting-human-pr-approval · iter 9' },
      { repo: '/repoB', body: 'error · iter 3' },
    ];
    expect.soft(delivered()).toEqual(expected);
    focused = false;
    for (const listener of listeners) listener();
    focused = true;
    for (const listener of listeners) listener();
    expect(delivered()).toEqual(expected);
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

  it('publication never activates the terminal or opens its loop panel', () => {
    const { notifier, focusWindow, reveal } = harness();
    notifier.observe(REPO, loopView({ status: 'awaiting-human-pr-approval', iteration: 9 }));
    expect(focusWindow).not.toHaveBeenCalled();
    expect(reveal).not.toHaveBeenCalled();
  });

  it('a failed notification sink does not interrupt observation of terminal work', () => {
    const { notifier } = harness({ notify: () => { throw new Error('controller disconnected'); } });
    expect.soft(() => notifier.observe(REPO, loopView({ status: 'error', iteration: 9 }))).not.toThrow();
    expect(() => notifier.observe(REPO, loopView({ status: 'working', iteration: 9, humanNeeded: false }))).not.toThrow();
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
  expect(notify.mock.calls.map(([message]) => message.body)).toEqual(['error · iter 1']);
});
