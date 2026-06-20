// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFlowStrip } from '../../src/renderer/src/flowStrip';
import { FLOW_CHANGED_EVENT } from '../../src/renderer/src/paneActions';
import type { FlowStateView, FlowStatus } from '../../src/shared/ipc';

// §24.2.2 / §22.3 — the flow status strip renders the §24.1 mockup station rail (Not started ·
// <step> · Completed) and a Start → Advance → Restart control. It FOLLOWS THE CWD: it holds the
// current repoKey and re-pulls/re-renders on `onRepoChanged`, threading that key into every
// window.flow call (mirroring the repo-scoped todo list). Before a repo key is known it renders
// nothing. Tests assert rendered DOM + the repoKey threaded into the dep calls.

function fakeFlow(initial: FlowStatus = 'not_started') {
  const byKey = new Map<string, FlowStatus>();
  const view = (repoKey: string): FlowStateView => {
    const status = byKey.get(repoKey) ?? initial;
    return { stepName: `${repoKey}-step`, position: 1, total: 1, status };
  };
  return {
    state: vi.fn(async (repoKey: string) => view(repoKey)),
    start: vi.fn(async (repoKey: string) => {
      byKey.set(repoKey, 'in_progress');
      return view(repoKey);
    }),
    advance: vi.fn(async (repoKey: string) => {
      byKey.set(repoKey, 'done');
      return view(repoKey);
    }),
    restart: vi.fn(async (repoKey: string) => {
      byKey.set(repoKey, 'in_progress');
      return view(repoKey);
    }),
    undo: vi.fn(async (repoKey: string) => {
      byKey.set(repoKey, 'in_progress');
      return view(repoKey);
    }),
    onStateChanged: vi.fn((_cb: () => void) => () => {}),
  };
}

const noopSub = vi.fn((_cb: () => void) => () => {});

let host: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = '<div id="host"></div>';
  host = document.getElementById('host')!;
});
afterEach(() => {
  document.body.innerHTML = '';
});

const sect = () => host.querySelector('.sect')?.textContent ?? '';
const stations = () => [...host.querySelectorAll<HTMLElement>('.flow.vert .stn')];
const stepName = () => stations()[1]?.querySelector('.nm')?.textContent ?? ''; // station 1 = the real step
const stateOf = (i: number) => {
  const cl = stations()[i].classList;
  return cl.contains('active') ? 'active' : cl.contains('done') ? 'done' : 'todo';
};
const control = () => host.querySelector<HTMLButtonElement>('.flow-control');

describe('flow status strip (§22.3 / §24.2.2)', () => {
  it('renders nothing until a repo key is known (follows cwd)', async () => {
    const deps = fakeFlow();
    await createFlowStrip(host, deps).refresh();
    expect(host.childElementCount).toBe(0);
    expect(deps.state).not.toHaveBeenCalled();
  });

  it('on the current repo, brackets the step with Not-started / Completed stations + a Start control', async () => {
    const deps = fakeFlow();
    createFlowStrip(host, deps).onRepoChanged('/repo');
    await vi.waitFor(() => expect(stations()).toHaveLength(3));
    expect(deps.state).toHaveBeenCalledWith('/repo');
    expect(stepName()).toBe('/repo-step');
    expect([stateOf(0), stateOf(1), stateOf(2)]).toEqual(['active', 'todo', 'todo']);
    expect(sect()).toBe('Flow — step 1 / 3');
    expect(control()!.textContent).toBe('Start');
  });

  it('re-pulls and re-renders for the new repo when the cwd changes', async () => {
    const deps = fakeFlow();
    const strip = createFlowStrip(host, deps);
    strip.onRepoChanged('/a');
    await vi.waitFor(() => expect(stepName()).toBe('/a-step'));
    strip.onRepoChanged('/b');
    await vi.waitFor(() => expect(stepName()).toBe('/b-step'));
    expect(deps.state).toHaveBeenCalledWith('/b');
  });

  it('Start invokes start() for the current repo and moves the step to active', async () => {
    const deps = fakeFlow();
    createFlowStrip(host, deps).onRepoChanged('/repo');
    await vi.waitFor(() => expect(control()!.textContent).toBe('Start'));
    control()!.click();
    await vi.waitFor(() => expect(stateOf(1)).toBe('active'));
    expect(deps.start).toHaveBeenCalledWith('/repo');
    expect(control()!.textContent).toBe('Advance');
  });

  it('Advance completes the flow (Completed active) and shows Restart, scoped to the repo', async () => {
    const deps = fakeFlow('in_progress');
    createFlowStrip(host, deps).onRepoChanged('/repo');
    await vi.waitFor(() => expect(control()!.textContent).toBe('Advance'));
    control()!.click();
    await vi.waitFor(() => expect(stateOf(2)).toBe('active'));
    expect(deps.advance).toHaveBeenCalledWith('/repo');
    expect(control()!.textContent).toBe('Restart');
  });

  it('Restart from done re-runs the step for the repo', async () => {
    const deps = fakeFlow('done');
    createFlowStrip(host, deps).onRepoChanged('/repo');
    await vi.waitFor(() => expect(control()!.textContent).toBe('Restart'));
    control()!.click();
    await vi.waitFor(() => expect(stateOf(1)).toBe('active'));
    expect(deps.restart).toHaveBeenCalledWith('/repo');
    expect(control()!.textContent).toBe('Advance');
  });

  it('done offers an Undo (revert the advance) alongside Restart; Undo returns to in-progress', async () => {
    const deps = fakeFlow('done');
    createFlowStrip(host, deps).onRepoChanged('/repo');
    await vi.waitFor(() => expect(control()!.textContent).toBe('Restart'));
    const undo = host.querySelector<HTMLButtonElement>('.flow-undo');
    expect(undo).not.toBeNull(); // every completed (manual-advanced) step can be undone
    expect(undo!.textContent).toBe('Undo');

    undo!.click();
    await vi.waitFor(() => expect(stateOf(1)).toBe('active')); // back to in-progress
    expect(deps.undo).toHaveBeenCalledWith('/repo');
    expect(deps.restart).not.toHaveBeenCalled();
    expect(host.querySelector('.flow-undo')).toBeNull(); // no longer done → no Undo
  });

  it('shows no Undo outside the done state', async () => {
    const deps = fakeFlow('in_progress');
    createFlowStrip(host, deps).onRepoChanged('/repo');
    await vi.waitFor(() => expect(control()!.textContent).toBe('Advance'));
    expect(host.querySelector('.flow-undo')).toBeNull();
  });

  it('renders a one-shot notice returned by start(), and a re-pull clears it (§24.2.2 S4)', async () => {
    const notified: FlowStateView = {
      stepName: '/repo-step',
      position: 1,
      total: 1,
      status: 'in_progress',
      notice: 'agent is busy — wait or interrupt, then retry',
    };
    const deps = {
      state: vi.fn(
        async (): Promise<FlowStateView> => ({ stepName: '/repo-step', position: 1, total: 1, status: 'not_started' }),
      ),
      start: vi.fn(async (): Promise<FlowStateView> => notified),
      advance: vi.fn(),
      restart: vi.fn(),
      undo: vi.fn(),
      onStateChanged: noopSub,
    };
    const strip = createFlowStrip(host, deps);
    strip.onRepoChanged('/repo');
    await vi.waitFor(() => expect(control()!.textContent).toBe('Start'));

    control()!.click();
    await vi.waitFor(() =>
      expect(host.querySelector('.flow-notice')?.textContent).toContain('agent is busy'),
    );

    await strip.refresh(); // a re-pull (state() carries no notice) clears the one-shot line
    expect(host.querySelector('.flow-notice')).toBeNull();
  });

  it('carries no template picker — that moved to the todo overlay (§4.1/§9.1)', async () => {
    const deps = fakeFlow('in_progress');
    createFlowStrip(host, deps).onRepoChanged('/repo');
    await vi.waitFor(() => expect(control()!.textContent).toBe('Advance'));
    expect(host.querySelector('.flow-template-pick')).toBeNull();
    expect(host.querySelector('.flow-template-add')).toBeNull();
  });

  it('signals flow-changed after a transition so the todo overlay re-pulls its picker (§4.1)', async () => {
    const fired = vi.fn();
    window.addEventListener(FLOW_CHANGED_EVENT, fired);
    createFlowStrip(host, fakeFlow()).onRepoChanged('/repo');
    await vi.waitFor(() => expect(control()!.textContent).toBe('Start'));
    control()!.click(); // Start → in_progress
    await vi.waitFor(() => expect(control()!.textContent).toBe('Advance'));
    await vi.waitFor(() => expect(fired).toHaveBeenCalled());
    window.removeEventListener(FLOW_CHANGED_EVENT, fired);
  });

  it('renders the derived n/m done + agent activity while in_progress (§24.2.2 S5)', async () => {
    const deps = {
      state: vi.fn(
        async (): Promise<FlowStateView> => ({
          stepName: '/repo-step',
          position: 1,
          total: 1,
          status: 'in_progress',
          derived: { activity: 'active', todosDone: 2, todosTotal: 5, ready: false },
        }),
      ),
      start: vi.fn(),
      advance: vi.fn(),
      restart: vi.fn(),
      undo: vi.fn(),
      onStateChanged: noopSub,
    };
    createFlowStrip(host, deps).onRepoChanged('/repo');
    await vi.waitFor(() => expect(host.querySelector('.flow-derived')).not.toBeNull());
    const text = host.querySelector<HTMLElement>('.flow-derived')!.textContent ?? '';
    expect(text).toContain('2 / 5');
    expect(text.toLowerCase()).toContain('active');
  });

  it('re-pulls flow:state when main emits flow:onStateChanged — the push path (§24.2.2 S5)', async () => {
    let fire = (): void => {};
    let done = 0;
    const deps = {
      state: vi.fn(
        async (): Promise<FlowStateView> => ({
          stepName: '/repo-step',
          position: 1,
          total: 1,
          status: 'in_progress',
          derived: { activity: 'quiet', todosDone: done, todosTotal: 3, ready: false },
        }),
      ),
      start: vi.fn(),
      advance: vi.fn(),
      restart: vi.fn(),
      undo: vi.fn(),
      onStateChanged: vi.fn((cb: () => void) => {
        fire = cb;
        return () => {};
      }),
    };
    createFlowStrip(host, deps).onRepoChanged('/repo');
    await vi.waitFor(() => expect(host.querySelector('.flow-derived')!.textContent).toContain('0 / 3'));

    done = 2;
    fire(); // main pushed a change — the strip re-pulls with NO user action and NO manual refresh
    await vi.waitFor(() => expect(host.querySelector('.flow-derived')!.textContent).toContain('2 / 3'));
    expect(deps.state.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('renders a clear --danger error line (no stations, no control) on load failure', async () => {
    const deps = {
      state: vi.fn(
        async (): Promise<FlowStateView> => ({
          stepName: '',
          position: 0,
          total: 0,
          status: 'error' as FlowStatus,
          error: 'flow.yaml not found',
        }),
      ),
      start: vi.fn(),
      advance: vi.fn(),
      restart: vi.fn(),
      undo: vi.fn(),
      onStateChanged: noopSub,
    };
    createFlowStrip(host, deps).onRepoChanged('/repo');
    await vi.waitFor(() => expect(host.querySelector('.flow-error')).not.toBeNull());
    expect(host.querySelector<HTMLElement>('.flow-error')!.textContent).toContain('flow.yaml not found');
    expect(stations()).toHaveLength(0);
    expect(control()).toBeNull();
  });
});
