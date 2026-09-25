// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFlowStrip } from '../../src/renderer/src/flowStrip';
import { assertRendersFromHostDocument } from './relocatable';
import { FLOW_CHANGED_EVENT } from '../../src/renderer/src/paneActions';
import type { AgentState, FlowStateView, FlowStatus } from '../../src/shared/ipc';
import { IDLE_STATUS_BAR, type StatusBarModel } from '../../src/shared/statusBar';

// §24.2.2 / §24.2.3 T1 / §22.3 — the flow status strip. It follows the cwd: every window.flow call
// must carry the current repoKey, so a stale-repo response must never repaint the rail (§16.3).

function fakeFlow(initial: FlowStatus = 'not_started') {
  const byKey = new Map<string, FlowStatus>();
  const view = (repoKey: string): FlowStateView => {
    const status = byKey.get(repoKey) ?? initial;
    return { stepName: `${repoKey}-step`, runStarted: 'never-started' as const, steps: [`${repoKey}-step`], position: 1, total: 1, status };
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
    terminate: vi.fn(async (repoKey: string) => {
      byKey.set(repoKey, 'not_started');
      return view(repoKey);
    }),
    provideInput: vi.fn(async (repoKey: string) => view(repoKey)),
    onStateChanged: vi.fn((_cb: () => void) => () => {}),
    onStatusBar: vi.fn((_m: StatusBarModel, _k: string | null) => {}),
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
const stepName = () => stations()[1]?.querySelector('.nm')?.textContent ?? ''; // station 0 is the bookend
const stateOf = (i: number) => {
  const cl = stations()[i].classList;
  return cl.contains('active') ? 'active' : cl.contains('done') ? 'done' : 'todo';
};
const control = () => host.querySelector<HTMLButtonElement>('.flow-control');
const segs = () => [...host.querySelectorAll<HTMLElement>('.flow.vert .seg')];
// A connector bar touches the current step when the active station is one of its two neighbours in
// the interleaved station/seg column.
const segTouchesActive = (seg: HTMLElement): boolean =>
  [seg.previousElementSibling, seg.nextElementSibling].some(
    (n) => n instanceof HTMLElement && n.classList.contains('stn') && n.classList.contains('active'),
  );

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
    expect(sect()).toBe('Flow — step 1 / 3'); // synthetic-inclusive: the bookends count toward the total
    expect(control()!.textContent).toBe('Start');
  });

  it('draws connector bars only on the current step (the active station), tightening the rail', async () => {
    const deps = fakeFlow();
    const strip = createFlowStrip(host, deps);
    strip.onRepoChanged('/repo');

    // not_started → active is the "Not started" bookend (first station): one connector below it, none
    // elsewhere in the [active, todo, todo] rail.
    await vi.waitFor(() => expect(stateOf(0)).toBe('active'));
    expect(segs()).toHaveLength(1);
    expect(segs().every(segTouchesActive)).toBe(true);

    // in_progress → the active station is the interior step: connectors above AND below it — both of
    // the rail's two inter-station gaps are drawn.
    (control() as HTMLButtonElement).click();
    await vi.waitFor(() => expect(stateOf(1)).toBe('active'));
    expect(segs()).toHaveLength(2);
    expect(segs().every(segTouchesActive)).toBe(true);

    // done → the active station is the "Completed" bookend (last station): one connector above it.
    (control() as HTMLButtonElement).click();
    await vi.waitFor(() => expect(stateOf(2)).toBe('active'));
    expect(segs()).toHaveLength(1);
    expect(segs().every(segTouchesActive)).toBe(true);
  });

  it('discards a late refresh from the prior repo after the new repo has rendered', async () => {
    let resolveA: (view: FlowStateView) => void = () => {};
    let resolveB: (view: FlowStateView) => void = () => {};
    const onStatusBar = vi.fn();
    const deps = {
      ...fakeFlow(),
      state: vi.fn((repoKey: string) => new Promise<FlowStateView>((resolve) => {
        if (repoKey === '/repoA') resolveA = resolve;
        else resolveB = resolve;
      })),
      onStatusBar,
    };
    const strip = createFlowStrip(host, deps);
    strip.onRepoChanged('/repoA');
    await vi.waitFor(() => expect(deps.state).toHaveBeenCalledWith('/repoA'));
    strip.onRepoChanged('/repoB');
    await vi.waitFor(() => expect(deps.state).toHaveBeenCalledWith('/repoB'));

    resolveB({ stepName: 'Repo B', runStarted: 'never-started' as const, steps: ['Repo B'], position: 1, total: 1, status: 'not_started', userTitle: 'B' });
    await vi.waitFor(() => expect(stepName()).toBe('Repo B'));
    resolveA({ stepName: 'Repo A', runStarted: 'never-started' as const, steps: ['Repo A'], position: 1, total: 1, status: 'not_started', userTitle: 'A' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(stepName()).toBe('Repo B');
    expect(onStatusBar.mock.calls.at(-1)?.[1]).toBe('/repoB');
    expect(onStatusBar.mock.calls.at(-1)?.[0].title).toEqual({ kind: 'user', text: 'B' });
  });

  it('does not repaint a disposed strip when an in-flight refresh resolves after teardown', async () => {
    let resolve: (view: FlowStateView) => void = () => {};
    const deps = { ...fakeFlow(), state: vi.fn(() => new Promise<FlowStateView>((r) => (resolve = r))) };
    const strip = createFlowStrip(host, deps);
    strip.onRepoChanged('/repo');
    await vi.waitFor(() => expect(deps.state).toHaveBeenCalledWith('/repo'));
    strip.dispose();
    resolve({ stepName: 'Late', runStarted: 'never-started' as const, steps: ['Late'], position: 1, total: 1, status: 'not_started' });
    await new Promise((r) => setTimeout(r, 0));
    expect(host.childElementCount).toBe(0);
  });

  it('removes repo A controls while a repo B pull is pending and leaves them removed if it rejects', async () => {
    const onStatusBar = vi.fn();
    const onPanelState = vi.fn();
    const deps = {
      ...fakeFlow(),
      state: vi.fn((repoKey: string) =>
        repoKey === '/repoA'
          ? Promise.resolve({ stepName: 'Repo A', runStarted: 'never-started' as const, steps: ['Repo A'], position: 1, total: 1, status: 'not_started' as FlowStatus })
          : Promise.reject(new Error('repo B unavailable')),
      ),
      onStatusBar,
      onPanelState,
    };
    const strip = createFlowStrip(host, deps);
    strip.onRepoChanged('/repoA');
    await vi.waitFor(() => expect(stepName()).toBe('Repo A'));

    strip.onRepoChanged('/repoB');
    expect(host.childElementCount).toBe(0);
    expect(onStatusBar).toHaveBeenLastCalledWith(IDLE_STATUS_BAR, null);
    expect(onPanelState).toHaveBeenLastCalledWith(null, '');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.childElementCount).toBe(0);
  });

  // §22.3.1 — what the engine is doing shows in the status bar, and ONLY there. The rail keeps the loop
  // read-out (tone pill, iteration, cost) and no busy signal of its own: one busy surface, one place.
  it('renders no activity line — the status bar is the only busy surface', async () => {
    const deps = {
      ...fakeFlow('in_progress'),
      state: vi.fn(async () => ({
        stepName: 'plan', runStarted: 'never-started' as const,
        steps: ['plan'],
        position: 1,
        total: 1,
        status: 'in_progress' as FlowStatus,
        loopActivity: { phrase: 'Bootstrapping #40' },
      })),
    };
    createFlowStrip(host, deps).onRepoChanged('/repo');
    await vi.waitFor(() => expect(control()).not.toBeNull());
    expect(host.querySelector('.flow-activity')).toBeNull();
    expect(host.querySelector('.spin')).toBeNull();
    expect(host.textContent).not.toContain('Bootstrapping #40');
  });

  it('hands the status-bar model to the composition root, so the bar can show the engine activity', async () => {
    const onStatusBar = vi.fn();
    const deps = {
      ...fakeFlow('in_progress'),
      state: vi.fn(async () => ({
        stepName: 'plan', runStarted: 'never-started' as const,
        steps: ['plan'],
        position: 1,
        total: 1,
        status: 'in_progress' as FlowStatus,
        refs: { pr: 57 },
        loopActivity: { phrase: 'Bootstrapping #40' },
      })),
      onStatusBar,
    };
    createFlowStrip(host, deps).onRepoChanged('/repo');
    await vi.waitFor(() => expect(onStatusBar).toHaveBeenCalled());
    expect(onStatusBar.mock.calls.at(-1)![0]).toEqual({
      title: { kind: 'pr', number: 57 },
      activity: { phrase: 'Bootstrapping #40' },
      alert: null,
    });
    expect(onStatusBar.mock.calls.at(-1)![1]).toBe('/repo'); // the bar acts on the repo the model came from
  });

  it('gives the bar back its empty state when the terminal leaves every repo', async () => {
    // Without this the bar would go on showing the title, activity and alert of a repo the user has left.
    const onStatusBar = vi.fn();
    const strip = createFlowStrip(host, { ...fakeFlow('in_progress'), onStatusBar });
    strip.onRepoChanged('/repo');
    await vi.waitFor(() => expect(onStatusBar).toHaveBeenCalled());
    onStatusBar.mockClear();
    strip.onRepoChanged(null);
    expect(onStatusBar).toHaveBeenCalledWith(IDLE_STATUS_BAR, null);
  });

  it('hands every view it receives to onView, tagged with the repo it came from (A3 T8b fan-out)', async () => {
    const onView = vi.fn();
    const strip = createFlowStrip(host, { ...fakeFlow('not_started'), onView });
    strip.onRepoChanged('/repo');
    await vi.waitFor(() => expect(onView).toHaveBeenCalledWith('/repo', expect.objectContaining({ stepName: '/repo-step' })));
  });

  it('a throwing onView listener never stops the strip painting or pushing the status bar', async () => {
    const onStatusBar = vi.fn();
    const onView = vi.fn(() => {
      throw new Error('picker broke');
    });
    const strip = createFlowStrip(host, { ...fakeFlow('not_started'), onView, onStatusBar });
    strip.onRepoChanged('/repo');
    await vi.waitFor(() => expect(onView).toHaveBeenCalled());
    await vi.waitFor(() => expect(host.textContent).toContain('/repo-step'));
    expect(onStatusBar).toHaveBeenCalledWith(expect.anything(), '/repo');
    await strip.refresh();
    expect(host.textContent).toContain('/repo-step');
  });

  it('tells onView (null, null) when it goes idle: leaving a repo, and a refresh with no repo', async () => {
    const onView = vi.fn();
    const strip = createFlowStrip(host, { ...fakeFlow('not_started'), onView });
    strip.onRepoChanged('/a');
    await vi.waitFor(() => expect(onView).toHaveBeenCalledWith('/a', expect.anything()));

    onView.mockClear();
    strip.onRepoChanged('/b');
    expect(onView.mock.calls[0]).toEqual([null, null]);
    await vi.waitFor(() => expect(onView).toHaveBeenLastCalledWith('/b', expect.anything()));

    onView.mockClear();
    strip.onRepoChanged(null);
    expect(onView).toHaveBeenCalledWith(null, null);

    onView.mockClear();
    await strip.refresh();
    expect(onView.mock.calls).toEqual([[null, null]]);
  });

  it('never hands onView a late view for a repo it has left, nor any view after dispose', async () => {
    // The picker trusts onView's repoKey as the worktree a pick writes to, so a stale view would aim the write
    // at the repo the terminal already left.
    const onView = vi.fn();
    const pending = new Map<string, (v: FlowStateView) => void>();
    const viewOf = (repoKey: string): FlowStateView => ({
      stepName: `${repoKey}-step`, steps: [`${repoKey}-step`], position: 1, total: 1, status: 'not_started', runStarted: 'never-started',
    });
    const deps = {
      ...fakeFlow('not_started'),
      state: vi.fn((repoKey: string) => new Promise<FlowStateView>((res) => pending.set(repoKey, res))),
      onView,
    };
    const strip = createFlowStrip(host, deps);
    strip.onRepoChanged('/a');
    strip.onRepoChanged('/b');
    pending.get('/b')!(viewOf('/b'));
    await vi.waitFor(() => expect(onView).toHaveBeenLastCalledWith('/b', expect.objectContaining({ stepName: '/b-step' })));

    pending.get('/a')?.(viewOf('/a'));
    await new Promise((r) => setTimeout(r, 0));
    expect(onView.mock.calls.filter((c) => c[0] === '/a')).toEqual([]);
    expect(onView).toHaveBeenLastCalledWith('/b', expect.anything());

    onView.mockClear();
    void strip.refresh();
    strip.dispose();
    pending.get('/b')?.(viewOf('/b'));
    await new Promise((r) => setTimeout(r, 0));
    expect(onView.mock.calls.filter((c) => c[0] !== null)).toEqual([]);
  });

  it('hands a transition result to onView (Start)', async () => {
    const onView = vi.fn();
    createFlowStrip(host, { ...fakeFlow('not_started'), onView }).onRepoChanged('/repo');
    await vi.waitFor(() => expect(control()!.textContent).toBe('Start'));
    control()!.click();
    await vi.waitFor(() => expect(onView).toHaveBeenLastCalledWith('/repo', expect.objectContaining({ status: 'in_progress' })));
  });

  it('hands a transition result to onView (Terminate)', async () => {
    const onView = vi.fn();
    const onTerminate = vi.fn((_repoKey: string, confirm: () => void) => confirm());
    createFlowStrip(host, { ...fakeFlow('in_progress'), onView, onTerminate }).onRepoChanged('/repo');
    await vi.waitFor(() => expect(host.querySelector('.flow-terminate')).not.toBeNull());
    host.querySelector<HTMLButtonElement>('.flow-terminate')!.click();
    await vi.waitFor(() => expect(onView).toHaveBeenLastCalledWith('/repo', expect.objectContaining({ status: 'not_started' })));
  });

  it('hands a re-pulled view to onView when only its startedness changed', async () => {
    const onView = vi.fn();
    let runStarted: FlowStateView['runStarted'] = 'never-started';
    let fire: () => void = () => {};
    const deps = {
      ...fakeFlow('not_started'),
      state: vi.fn(async (): Promise<FlowStateView> => ({ stepName: 's', steps: ['s'], position: 1, total: 1, status: 'not_started', runStarted })),
      onStateChanged: vi.fn((cb: () => void) => {
        fire = cb;
        return () => {};
      }),
      onView,
    };
    createFlowStrip(host, deps).onRepoChanged('/repo');
    await vi.waitFor(() => expect(onView).toHaveBeenLastCalledWith('/repo', expect.objectContaining({ runStarted: 'never-started' })));

    runStarted = 'started';
    fire();

    await vi.waitFor(() => expect(onView).toHaveBeenLastCalledWith('/repo', expect.objectContaining({ runStarted: 'started' })));
  });

  // WCAG 2.1 SC 4.1.3. The host is `role=status`, which is an implicitly ATOMIC live region — a partial
  // text patch would still re-announce the WHOLE strip. The strip patches individual nodes (status,
  // iteration, cost, phrase), so it must mark its own host non-atomic or the patch buys nothing.
  it('marks its live-region host non-atomic so partial updates announce only what changed', () => {
    const strip = createFlowStrip(host, fakeFlow('in_progress'));
    strip.onRepoChanged('/repo');
    expect(host.getAttribute('aria-atomic')).toBe('false');
  });

  // A phrase moving 'Bootstrapping #12' -> 'Bootstrapping #13' arrives on a PASSIVE push, which the strip
  // answers by patching in place. The status bar must still be handed the new phrase — otherwise the one
  // surface that shows what the engine is doing freezes on the first phrase of the run.
  it('keeps the status bar live across a passive push that patches the strip in place', async () => {
    let phrase = 'Bootstrapping #12';
    let fire = (): void => {};
    const onStatusBar = vi.fn();
    const deps = {
      ...fakeFlow('in_progress'),
      state: vi.fn(async () => ({
        stepName: 'plan', runStarted: 'never-started' as const,
        steps: ['plan'],
        position: 1,
        total: 1,
        status: 'in_progress' as FlowStatus,
        loopActivity: { phrase },
      })),
      onStateChanged: vi.fn((cb: () => void) => {
        fire = cb;
        return () => {};
      }),
      onStatusBar,
    };
    createFlowStrip(host, deps).onRepoChanged('/repo');
    await vi.waitFor(() => expect(onStatusBar).toHaveBeenCalled());
    const stationBefore = host.querySelector('.stn')!;

    phrase = 'Bootstrapping #13';
    fire();

    await vi.waitFor(() =>
      expect(onStatusBar.mock.calls.at(-1)![0].activity).toEqual({ phrase: 'Bootstrapping #13' }),
    );
    expect(host.querySelector('.stn')).toBe(stationBefore); // the strip itself was patched, not rebuilt
  });

  it('reports no activity to the status bar when the engine is idle', async () => {
    const onStatusBar = vi.fn();
    createFlowStrip(host, { ...fakeFlow('in_progress'), onStatusBar }).onRepoChanged('/repo');
    await vi.waitFor(() => expect(onStatusBar).toHaveBeenCalled());
    expect(onStatusBar.mock.calls.at(-1)![0].activity).toBeNull();
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

  it('surfaces a transition write-failure instead of silently swallowing it', async () => {
    // persist() now THROWS when the write cannot land (a symlinked .agent-terminal), so a transition
    // that used to silently no-op now rejects. The user must be told, not left clicking Start into the
    // void with no recovery (CLAUDE.md — never silently swallow an unrecoverable error).
    const onError = vi.fn();
    const deps = { ...fakeFlow(), start: vi.fn(async () => { throw new Error('cannot write .agent-terminal/flow-state.yaml'); }), onError };
    createFlowStrip(host, deps).onRepoChanged('/repo');
    await vi.waitFor(() => expect(control()!.textContent).toBe('Start'));
    control()!.click();
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(String(onError.mock.calls[0][0])).toContain('cannot write');
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
    await vi.waitFor(() => expect(stateOf(1)).toBe('active'));
    expect(deps.undo).toHaveBeenCalledWith('/repo');
    expect(deps.restart).not.toHaveBeenCalled();
    expect(host.querySelector('.flow-undo')).toBeNull();
  });

  it('shows no Undo outside the done state', async () => {
    const deps = fakeFlow('in_progress');
    createFlowStrip(host, deps).onRepoChanged('/repo');
    await vi.waitFor(() => expect(control()!.textContent).toBe('Advance'));
    expect(host.querySelector('.flow-undo')).toBeNull();
  });

  const inProgress = (notice?: string): FlowStateView => ({
    stepName: '/repo-step', runStarted: 'never-started' as const,
    steps: ['/repo-step'],
    position: 1,
    total: 1,
    status: 'in_progress',
    ...(notice ? { notice } : {}),
  });

  it('holds a transition notice across a passive re-pull, clearing it only on the NEXT transition (§B.10 carrier, AC5)', async () => {
    // AC 5's migration notice arrives on the transition that enters the step; the ordinary success push
    // then drives a passive state re-pull carrying NO notice. Under the pre-sweep one-shot rule that
    // re-pull erased it before the operator could read it — the defect §B.5 position 6 names. The strip
    // now holds it across passive re-pulls and drops it only on the next transition.
    const deps = {
      state: vi.fn(async (): Promise<FlowStateView> => inProgress()), // passive pulls carry no notice
      start: vi.fn(),
      advance: vi.fn(async (): Promise<FlowStateView> => inProgress()), // the clearing transition
      restart: vi.fn(),
      undo: vi.fn(),
      terminate: vi.fn(),
      provideInput: vi.fn(),
      onStatusBar: vi.fn(),
      onStateChanged: noopSub,
    };
    deps.advance.mockResolvedValueOnce(inProgress('migrated: retired-schema customizations were not carried across'));
    const strip = createFlowStrip(host, deps);
    strip.onRepoChanged('/repo');
    await vi.waitFor(() => expect(control()!.textContent).toBe('Advance'));

    control()!.click(); // transition #1 raises the migration notice
    await vi.waitFor(() => expect(host.querySelector('.flow-notice')?.textContent).toContain('migrated'));
    const noticeNode = host.querySelector('.flow-notice'); // the node the transition created

    await strip.refresh(); // passive re-pull, state() carries no notice → HELD, not erased
    // §D.4 row 2838(c) / WCAG 4.1.3: HELD means the SAME node survives — a re-created node in the
    // role=status region would re-announce the unchanged notice to assistive tech. Identity, not presence.
    expect(host.querySelector('.flow-notice')).toBe(noticeNode);

    control()!.click(); // transition #2 carries no notice → clears the held line
    await vi.waitFor(() => expect(host.querySelector('.flow-notice')).toBeNull());
  });

  it('joins a passive re-pull\'s own notice to the held transition notice — both render (§B.10 carrier, AC5+AC10)', async () => {
    // The migration notice rides the transition; the coordinator's asynchronous §19.3 refusal (§B.5 item
    // 6) arrives on a LATER passive state push. They are on different responses, so the seam cannot join
    // them — the strip must, and neither may drop the other.
    const deps = {
      state: vi.fn(async (): Promise<FlowStateView> => inProgress()),
      start: vi.fn(),
      advance: vi.fn(async (): Promise<FlowStateView> => inProgress('migrated: retired-schema customizations were not carried across')),
      restart: vi.fn(),
      undo: vi.fn(),
      terminate: vi.fn(),
      provideInput: vi.fn(),
      onStatusBar: vi.fn(),
      onStateChanged: noopSub,
    };
    const strip = createFlowStrip(host, deps);
    strip.onRepoChanged('/repo');
    await vi.waitFor(() => expect(control()!.textContent).toBe('Advance'));
    control()!.click(); // transition raises the migration notice
    await vi.waitFor(() => expect(host.querySelector('.flow-notice')?.textContent).toContain('migrated'));

    // A later passive push carries the coordinator's own busy-shell refusal.
    deps.state.mockResolvedValueOnce(inProgress('agent is busy — wait or interrupt, then retry'));
    await strip.refresh();

    const notices = [...host.querySelectorAll('.flow-notice')].map((n) => n.textContent).join(' | ');
    expect(notices).toContain('migrated');
    expect(notices).toContain('agent is busy');
  });

  it('clears the held notice on a repo change — it belongs to the prior repo\'s step (§B.10 carrier)', async () => {
    const deps = {
      state: vi.fn(async (): Promise<FlowStateView> => inProgress()),
      start: vi.fn(),
      advance: vi.fn(async (): Promise<FlowStateView> => inProgress('migrated: retired-schema customizations were not carried across')),
      restart: vi.fn(),
      undo: vi.fn(),
      terminate: vi.fn(),
      provideInput: vi.fn(),
      onStatusBar: vi.fn(),
      onStateChanged: noopSub,
    };
    const strip = createFlowStrip(host, deps);
    strip.onRepoChanged('/repo');
    await vi.waitFor(() => expect(control()!.textContent).toBe('Advance'));
    control()!.click();
    await vi.waitFor(() => expect(host.querySelector('.flow-notice')).not.toBeNull());

    strip.onRepoChanged('/other-repo');
    await vi.waitFor(() => expect(host.querySelector('.flow-notice')).toBeNull());
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
          stepName: '/repo-step', runStarted: 'never-started' as const,
          steps: ['/repo-step'],
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
      terminate: vi.fn(),
      provideInput: vi.fn(),
      onStatusBar: vi.fn(),
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
          stepName: '/repo-step', runStarted: 'never-started' as const,
          steps: ['/repo-step'],
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
      terminate: vi.fn(),
      provideInput: vi.fn(),
      onStatusBar: vi.fn(),
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

  it('brackets N real steps with the Not-started / Completed bookends, lit by position/status (§24.2.3 T1)', async () => {
    const deps = {
      state: vi.fn(
        async (): Promise<FlowStateView> => ({
          stepName: 'plan', runStarted: 'never-started' as const,
          steps: ['groom', 'plan', 'implement'],
          position: 2,
          total: 3,
          status: 'in_progress',
        }),
      ),
      start: vi.fn(),
      advance: vi.fn(),
      restart: vi.fn(),
      undo: vi.fn(),
      terminate: vi.fn(),
      provideInput: vi.fn(),
      onStatusBar: vi.fn(),
      onStateChanged: noopSub,
    };
    createFlowStrip(host, deps).onRepoChanged('/repo');
    await vi.waitFor(() => expect(stations()).toHaveLength(5));
    expect(stations().map((s) => s.querySelector('.nm')?.textContent)).toEqual([
      'Not started',
      'groom',
      'plan',
      'implement',
      'Completed',
    ]);
    expect([stateOf(0), stateOf(1), stateOf(2), stateOf(3), stateOf(4)]).toEqual([
      'done',
      'done',
      'active',
      'todo',
      'todo',
    ]);
    expect(sect()).toBe('Flow — step 3 / 5'); // synthetic-inclusive: the bookends count toward the total
    expect(control()!.textContent).toBe('Advance');
  });

  it('renders the compact Loop read-out (tone label + iteration) that opens the docked panel (§24.2.3 T2)', async () => {
    const deps = {
      state: vi.fn(
        async (): Promise<FlowStateView> => ({
          stepName: 'build', runStarted: 'never-started' as const,
          steps: ['groom', 'build'],
          position: 2,
          total: 2,
          status: 'in_progress',
          loop: { status: 'awaiting-human-pr-approval', iteration: 9, pr: 179, branch: 'agent-loop/issue-176', ready: false },
        }),
      ),
      start: vi.fn(),
      advance: vi.fn(),
      restart: vi.fn(),
      undo: vi.fn(),
      terminate: vi.fn(),
      provideInput: vi.fn(),
      onStatusBar: vi.fn(),
      onStateChanged: noopSub,
      loopPanelId: 'loop-panel',
    };
    createFlowStrip(host, deps).onRepoChanged('/repo');
    await vi.waitFor(() => expect(host.querySelector('.loopstat')).not.toBeNull());
    const readout = host.querySelector<HTMLElement>('.loopstat')!;
    expect(readout.getAttribute('role')).toBe('button');
    expect(readout.getAttribute('aria-controls')).toBe('loop-panel'); // the injected id, never hard-coded (UI-STANDARDS §2.2 rule 1)
    const pill = readout.querySelector<HTMLElement>('.spill')!;
    expect(pill.classList.contains('await')).toBe(true);
    expect(pill.textContent).toContain('awaiting');
    expect(readout.textContent).toContain('iter 9');
    // The exact status/pr/branch live in the docked panel, not the compact read-out.
    expect(readout.textContent).not.toContain('#179');
  });

  it('omits the iteration read-out when no round has run (a §27 run-less view, absent iteration)', async () => {
    const runLess: FlowStateView = {
      stepName: 'plan', runStarted: 'never-started' as const,
      steps: ['plan'],
      position: 1,
      total: 1,
      status: 'in_progress',
      loop: { status: 'not-started', pr: null, branch: null, ready: false, actionable: false, gateOptions: ['approve'] },
    };
    const deps = {
      state: vi.fn(async (): Promise<FlowStateView> => runLess),
      start: vi.fn(),
      advance: vi.fn(),
      restart: vi.fn(),
      undo: vi.fn(),
      terminate: vi.fn(),
      provideInput: vi.fn(),
      onStatusBar: vi.fn(),
      onStateChanged: noopSub,
    };
    createFlowStrip(host, deps).onRepoChanged('/repo');
    await vi.waitFor(() => expect(host.querySelector('.loopstat')).not.toBeNull());
    const readout = host.querySelector<HTMLElement>('.loopstat')!;
    expect(readout.textContent).not.toContain('iter');
    expect(host.querySelector('.loop-iter')).toBeNull();
  });

  it('renders no running-cost read-out on the loop rail — the retired cost node is gone (AC 9)', async () => {
    const deps = {
      state: vi.fn(
        async (): Promise<FlowStateView> => ({
          stepName: 'build', runStarted: 'never-started' as const,
          steps: ['build'],
          position: 1,
          total: 1,
          status: 'in_progress' as FlowStatus,
          loop: { status: 'impl-review', iteration: 3, pr: 12, branch: 'agent-loop/x', ready: false },
        }),
      ),
      start: vi.fn(),
      advance: vi.fn(),
      restart: vi.fn(),
      undo: vi.fn(),
      terminate: vi.fn(),
      provideInput: vi.fn(),
      onStatusBar: vi.fn(),
      onStateChanged: noopSub,
    };
    createFlowStrip(host, deps).onRepoChanged('/repo');
    await vi.waitFor(() => expect(host.querySelector('.loopstat')).not.toBeNull());
    // the retired running-cost node — its structure and its value — no longer renders; no surface asserts a cost
    expect(host.querySelector('.loop-cost')).toBeNull();
    expect(host.querySelector<HTMLElement>('.loopstat')!.textContent).not.toMatch(/\$\s*\d/);
  });

  it('omits aria-controls on the loop read-out when no panel id is injected (no hard-coded global id)', async () => {
    const deps = {
      state: vi.fn(
        async (): Promise<FlowStateView> => ({
          stepName: 'build', runStarted: 'never-started' as const,
          steps: ['build'],
          position: 1,
          total: 1,
          status: 'in_progress' as FlowStatus,
          loop: { status: 'impl-review', iteration: 3, pr: 12, branch: 'agent-loop/x', ready: false },
        }),
      ),
      start: vi.fn(),
      advance: vi.fn(),
      restart: vi.fn(),
      undo: vi.fn(),
      terminate: vi.fn(),
      provideInput: vi.fn(),
      onStatusBar: vi.fn(),
      onStateChanged: noopSub,
      // no loopPanelId → the strip must not bake in a document-level id (UI-STANDARDS §2.2 rule 1)
    };
    createFlowStrip(host, deps).onRepoChanged('/repo');
    await vi.waitFor(() => expect(host.querySelector('.loopstat')).not.toBeNull());
    expect(host.querySelector<HTMLElement>('.loopstat')!.hasAttribute('aria-controls')).toBe(false);
  });

  it('hands the flow refs to the docked panel via onPanelState, even on a non-loop step (§24.2.3 T7)', async () => {
    const onPanelState = vi.fn();
    const deps = {
      state: vi.fn(
        async (): Promise<FlowStateView> => ({
          stepName: 'groom', runStarted: 'never-started' as const,
          steps: ['groom', 'plan'],
          position: 1,
          total: 2,
          status: 'in_progress' as FlowStatus,
          refs: { ticket: 25, pr: 29 },
        }),
      ),
      start: vi.fn(),
      advance: vi.fn(),
      restart: vi.fn(),
      undo: vi.fn(),
      provideInput: vi.fn(),
      onStatusBar: vi.fn(),
      terminate: vi.fn(),
      onStateChanged: noopSub,
      onPanelState,
    };
    createFlowStrip(host, deps).onRepoChanged('/repo');
    await vi.waitFor(() => expect(onPanelState).toHaveBeenCalled());
    const last = onPanelState.mock.calls.at(-1)!;
    expect(last[2]).toEqual({ ticket: 25, pr: 29 }); // (loop, title, refs)
  });

  it('renders a Loop read-out opener on a NON-loop step that carries refs (§24.2.3 T7)', async () => {
    const deps = {
      state: vi.fn(
        async (): Promise<FlowStateView> => ({
          stepName: 'groom', runStarted: 'never-started' as const,
          steps: ['groom', 'plan'],
          position: 1,
          total: 2,
          status: 'in_progress' as FlowStatus,
          refs: { ticket: 25, pr: 29 },
        }),
      ),
      start: vi.fn(),
      advance: vi.fn(),
      restart: vi.fn(),
      undo: vi.fn(),
      provideInput: vi.fn(),
      onStatusBar: vi.fn(),
      terminate: vi.fn(),
      onStateChanged: noopSub,
      loopPanelId: 'loop-panel',
    };
    createFlowStrip(host, deps).onRepoChanged('/repo');
    await vi.waitFor(() => expect(host.querySelector('.loopstat')).not.toBeNull());
    const readout = host.querySelector<HTMLElement>('.loopstat')!;
    expect(readout.getAttribute('role')).toBe('button');
    expect(readout.getAttribute('aria-controls')).toBe('loop-panel');
    expect(readout.textContent).toContain('#25');
    expect(readout.textContent).toContain('#29');
  });

  it('keeps the refs on the docked panel across a same-signature background push (§24.2.3 T7 / S5)', async () => {
    // A passive flow:onStateChanged push that changes only a live value (loop iteration) keeps the
    // structural signature equal and takes the patch-in-place path. That path must still hand the refs
    // to the panel, or a routine background tick wipes the "Working on" ticket/PR section.
    let fire = (): void => {};
    let iteration = 1;
    const onPanelState = vi.fn();
    const deps = {
      state: vi.fn(
        async (): Promise<FlowStateView> => ({
          stepName: 'build', runStarted: 'never-started' as const,
          steps: ['build'],
          position: 1,
          total: 1,
          status: 'in_progress' as FlowStatus,
          loop: { status: 'impl-draft', iteration, pr: 29, branch: 'b', ready: false },
          refs: { ticket: 25, pr: 29 },
        }),
      ),
      start: vi.fn(),
      advance: vi.fn(),
      restart: vi.fn(),
      undo: vi.fn(),
      terminate: vi.fn(),
      provideInput: vi.fn(),
      onStatusBar: vi.fn(),
      onStateChanged: vi.fn((cb: () => void) => {
        fire = cb;
        return () => {};
      }),
      onPanelState,
    };
    createFlowStrip(host, deps).onRepoChanged('/repo');
    await vi.waitFor(() => expect(onPanelState).toHaveBeenCalled());
    expect(onPanelState.mock.calls.at(-1)![2]).toEqual({ ticket: 25, pr: 29 });

    iteration = 2; // only a live value changed → same structural signature → patch-in-place path
    fire();
    await vi.waitFor(() => expect(deps.state.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(onPanelState.mock.calls.at(-1)![2]).toEqual({ ticket: 25, pr: 29 });
  });

  it('re-renders the rail refs read-out when a background push changes only the refs (§24.2.3 T7)', async () => {
    // refs are part of structuralSig, so a refs-only change forces a full render — the compact rail
    // summary (which has no patch handler) must reflect the new number, not stay stale.
    let fire = (): void => {};
    let ticket = 25;
    const deps = {
      state: vi.fn(
        async (): Promise<FlowStateView> => ({
          stepName: 'groom', runStarted: 'never-started' as const,
          steps: ['groom', 'plan'],
          position: 1,
          total: 2,
          status: 'in_progress' as FlowStatus,
          refs: { ticket },
        }),
      ),
      start: vi.fn(),
      advance: vi.fn(),
      restart: vi.fn(),
      undo: vi.fn(),
      terminate: vi.fn(),
      provideInput: vi.fn(),
      onStatusBar: vi.fn(),
      onStateChanged: vi.fn((cb: () => void) => {
        fire = cb;
        return () => {};
      }),
    };
    createFlowStrip(host, deps).onRepoChanged('/repo');
    await vi.waitFor(() => expect(host.querySelector('.loopstat')?.textContent).toContain('#25'));

    ticket = 26;
    fire();
    await vi.waitFor(() => expect(host.querySelector('.loopstat')?.textContent).toContain('#26'));
  });

  // A focus-landing seam for the composition root (WCAG 2.4.3): the root lands focus via this contract
  // rather than reaching into the strip's private `.loopstat`. The boolean return lets it fall back
  // when no loop is shown.
  describe('focusLoopReadout (focus-landing seam, §24.2.3 T4 / WCAG 2.4.3)', () => {
    const loopDeps = () => ({
      state: vi.fn(
        async (): Promise<FlowStateView> => ({
          stepName: 'build', runStarted: 'never-started' as const,
          steps: ['build'],
          position: 1,
          total: 1,
          status: 'in_progress' as FlowStatus,
          loop: { status: 'awaiting-human-pr-approval', iteration: 9, pr: 179, branch: 'b', ready: false },
        }),
      ),
      start: vi.fn(),
      advance: vi.fn(),
      restart: vi.fn(),
      undo: vi.fn(),
      terminate: vi.fn(),
      provideInput: vi.fn(),
      onStatusBar: vi.fn(),
      onStateChanged: noopSub,
    });

    it('focuses the loop read-out and reports it did when a loop is shown', async () => {
      const strip = createFlowStrip(host, loopDeps());
      strip.onRepoChanged('/repo');
      await vi.waitFor(() => expect(host.querySelector('.loopstat')).not.toBeNull());
      expect(strip.focusLoopReadout()).toBe(true);
      expect(document.activeElement).toBe(host.querySelector('.loopstat'));
    });

    it('reports it did not, and moves no focus, when no loop is shown', async () => {
      const strip = createFlowStrip(host, fakeFlow('in_progress'));
      strip.onRepoChanged('/repo');
      await vi.waitFor(() => expect(host.querySelector('.flow.vert')).not.toBeNull());
      const before = document.activeElement;
      expect(strip.focusLoopReadout()).toBe(false);
      expect(document.activeElement).toBe(before);
    });
  });

  // The other half of the same rule: a PASSIVE repaint must not pull focus away from wherever the
  // operator actually is. `render()` runs for onStateChanged pushes and onRepoChanged too, where focus
  // legitimately lives outside the strip (the terminal, the monitor pane) — WCAG 2.1 SC 3.2.5.
  it('leaves focus alone when a repaint finds the operator outside the strip', async () => {
    let fire: () => void = () => {};
    const flow = fakeFlow('in_progress');
    const deps = {
      ...flow,
      onStateChanged: vi.fn((cb: () => void) => {
        fire = cb;
        return () => {};
      }),
    };
    createFlowStrip(host, deps).onRepoChanged('/repo');
    await vi.waitFor(() => expect(host.querySelector('.flow-control')).not.toBeNull());

    const outside = host.ownerDocument.createElement('button');
    outside.textContent = 'terminal';
    host.ownerDocument.body.append(outside);
    outside.focus();
    expect(document.activeElement).toBe(outside);

    await flow.terminate('/repo'); // a background change repaints the strip under the operator
    fire();
    // Wait on the REPAINT, not on the state() call: refresh() invokes state synchronously, so a
    // call-count predicate is satisfied before render() has run and the assertion below would be
    // trivially true. The control's label only flips once the children have been replaced.
    await vi.waitFor(() => expect(control()!.textContent).toBe('Start'));

    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  // WCAG 2.4.3. A repaint that detaches the focused control must re-anchor focus, whatever path the
  // repaint arrives by — declining the §27.10 wipe rolls the step back through a plain state push, not
  // through a transition response, and left the keyboard user on <body>.
  it('re-anchors focus when a repaint detaches a control the operator was on', async () => {
    let fire: () => void = () => {};
    const flow = fakeFlow('in_progress');
    const deps = {
      ...flow,
      onStateChanged: vi.fn((cb: () => void) => {
        fire = cb;
        return () => {};
      }),
    };
    createFlowStrip(host, deps).onRepoChanged('/repo');
    await vi.waitFor(() => expect(host.querySelector('.flow-control')).not.toBeNull());
    host.querySelector<HTMLElement>('.flow-control')!.focus();
    expect(host.contains(document.activeElement)).toBe(true);

    await flow.terminate('/repo'); // the step rolls back underneath the operator
    fire();
    await vi.waitFor(() => expect(control()!.textContent).toBe('Start'));

    expect(document.activeElement).toBe(control());
  });

  it('maps an arbitrary per-LoopDef status onto one of three tones (await/work/settle)', async () => {
    const make = (status: string) => ({
      state: vi.fn(
        async (): Promise<FlowStateView> => ({
          stepName: 'build', runStarted: 'never-started' as const,
          steps: ['build'],
          position: 1,
          total: 1,
          status: 'in_progress' as FlowStatus,
          loop: { status, iteration: 1, pr: null, branch: null, ready: true },
        }),
      ),
      start: vi.fn(),
      advance: vi.fn(),
      restart: vi.fn(),
      undo: vi.fn(),
      terminate: vi.fn(),
      provideInput: vi.fn(),
      onStatusBar: vi.fn(),
      onStateChanged: noopSub,
    });
    const toneFor = async (status: string): Promise<string> => {
      host.replaceChildren();
      createFlowStrip(host, make(status)).onRepoChanged('/repo');
      await vi.waitFor(() => expect(host.querySelector('.loopstat .spill')).not.toBeNull());
      const cl = host.querySelector<HTMLElement>('.loopstat .spill')!.classList;
      return cl.contains('await') ? 'await' : cl.contains('settle') ? 'settle' : 'work';
    };
    expect(await toneFor('awaiting-human-pr-approval')).toBe('await');
    expect(await toneFor('impasse')).toBe('await');
    expect(await toneFor('impl-draft')).toBe('work');
    expect(await toneFor('merged')).toBe('settle');
  });

  it('shows no Loop read-out on a non-loop step', async () => {
    const deps = fakeFlow('in_progress');
    createFlowStrip(host, deps).onRepoChanged('/repo');
    await vi.waitFor(() => expect(control()!.textContent).toBe('Advance'));
    expect(host.querySelector('.loopstat')).toBeNull();
  });

  it('hands the loop mirror to the composition root via onPanelState, for the docked panel (§24.2.3 T2)', async () => {
    const seen: Array<{ status?: string; title: string }> = [];
    const loopView: FlowStateView = {
      stepName: 'build', runStarted: 'never-started' as const,
      steps: ['groom', 'build'],
      position: 2,
      total: 2,
      status: 'in_progress',
      loop: { status: 'awaiting-human-pr-approval', iteration: 9, pr: 179, branch: 'b', ready: false },
    };
    const deps = {
      state: vi.fn(async (): Promise<FlowStateView> => loopView),
      start: vi.fn(),
      advance: vi.fn(),
      restart: vi.fn(),
      undo: vi.fn(),
      terminate: vi.fn(),
      provideInput: vi.fn(),
      onStatusBar: vi.fn(),
      onStateChanged: noopSub,
      onPanelState: (loop: FlowStateView['loop'] | null, title: string) => seen.push({ status: loop?.status, title }),
    };
    createFlowStrip(host, deps).onRepoChanged('/repo');
    await vi.waitFor(() => expect(seen.some((s) => s.status === 'awaiting-human-pr-approval')).toBe(true));
    expect(seen.at(-1)!.title).toBe('build');
  });

  it('signals onPanelState(null) for a non-loop step so the panel clears and closes', async () => {
    const seen: Array<FlowStateView['loop'] | null> = [];
    const deps = { ...fakeFlow('in_progress'), onPanelState: (loop: FlowStateView['loop'] | null) => seen.push(loop) };
    createFlowStrip(host, deps).onRepoChanged('/repo');
    await vi.waitFor(() => expect(control()!.textContent).toBe('Advance'));
    expect(seen.at(-1)).toBeNull();
  });

  // §24.2.3 T3 — the prompt is transition-driven: a passive `state()` re-pull must NOT pop it, else a
  // background flow:onStateChanged refresh reopens the modal under the user.
  it('hands a step-entry input prompt to the composition root on a transition, and submit calls provideInput (§24.2.3 T3)', async () => {
    const seen: Array<{ names: string[]; stepName: string }> = [];
    let lastSubmit: ((v: Record<string, string>) => void) | undefined;
    const promptView: FlowStateView = {
      stepName: 'plan', runStarted: 'never-started' as const,
      steps: ['plan'],
      position: 1,
      total: 1,
      status: 'in_progress',
      prompt: { inputs: [{ name: 'ticket', type: 'github-ticket' }], bootstrap: 'agent-loop pickup' },
    };
    const provideInput = vi.fn(async (): Promise<FlowStateView> => ({ ...promptView, prompt: undefined, notice: 'booted' }));
    const deps = {
      state: vi.fn(async (): Promise<FlowStateView> => ({ ...promptView, status: 'not_started', prompt: undefined })),
      start: vi.fn(async (): Promise<FlowStateView> => promptView),
      advance: vi.fn(),
      restart: vi.fn(),
      undo: vi.fn(),
      terminate: vi.fn(),
      provideInput,
      onStateChanged: noopSub,
      onStatusBar: vi.fn(),
      onPrompt: (prompt: FlowStateView['prompt'] | null, stepName: string, submit: (v: Record<string, string>) => void) => {
        if (prompt) {
          seen.push({ names: prompt.inputs.map((i) => i.name), stepName });
          lastSubmit = submit;
        }
      },
    };
    createFlowStrip(host, deps).onRepoChanged('/repo');
    await vi.waitFor(() => expect(control()!.textContent).toBe('Start'));
    expect(seen).toHaveLength(0); // a passive state() pull does NOT pop the prompt

    control()!.click();
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
    expect(seen.at(-1)).toEqual({ names: ['ticket'], stepName: 'plan' });

    lastSubmit!({ ticket: '176' });
    expect(provideInput).toHaveBeenCalledWith('/repo', 'plan', { ticket: '176' });
  });

  it('surfaces a provideInput write-failure from a prompt submit instead of swallowing it', async () => {
    const onError = vi.fn();
    let submit: ((v: Record<string, string>) => void) | undefined;
    const promptView: FlowStateView = {
      stepName: 'plan', runStarted: 'never-started' as const,
      steps: ['plan'],
      position: 1,
      total: 1,
      status: 'in_progress',
      prompt: { inputs: [{ name: 'ticket', type: 'github-ticket' }], bootstrap: 'agent-loop pickup' },
    };
    const deps = {
      ...fakeFlow(),
      state: vi.fn(async (): Promise<FlowStateView> => ({ ...promptView, status: 'not_started', prompt: undefined })),
      start: vi.fn(async (): Promise<FlowStateView> => promptView),
      provideInput: vi.fn(async () => { throw new Error('cannot write .agent-terminal/flow-state.yaml'); }),
      onError,
      onPrompt: (prompt: FlowStateView['prompt'] | null, _stepName: string, s: (v: Record<string, string>) => void) => {
        if (prompt) submit = s;
      },
    };
    createFlowStrip(host, deps).onRepoChanged('/repo');
    await vi.waitFor(() => expect(control()!.textContent).toBe('Start'));
    control()!.click();
    await vi.waitFor(() => expect(submit).toBeDefined());
    submit!({ ticket: '176' });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(String(onError.mock.calls[0][0])).toContain('cannot write');
  });

  it('focuses a real flow control before opening the prompt, so the modal does not capture <body> as opener (WCAG 2.4.3)', async () => {
    // Coupling with flowInputModal: it captures its opener from activeElement on open. The rail rebuild
    // detaches the clicked control (focus → <body>), so the strip must re-anchor focus on a real control
    // BEFORE emitting the prompt, or focus restores to <body> on close.
    let openerAtPrompt: Element | null = null;
    const promptView: FlowStateView = {
      stepName: 'plan', runStarted: 'never-started' as const,
      steps: ['plan'],
      position: 1,
      total: 1,
      status: 'in_progress',
      prompt: { inputs: [{ name: 'ticket', type: 'github-ticket' }], bootstrap: 'agent-loop pickup' },
    };
    const deps = {
      state: vi.fn(async (): Promise<FlowStateView> => ({ ...promptView, status: 'not_started' as FlowStatus, prompt: undefined })),
      start: vi.fn(async (): Promise<FlowStateView> => promptView),
      advance: vi.fn(),
      restart: vi.fn(),
      undo: vi.fn(),
      terminate: vi.fn(),
      provideInput: vi.fn(),
      onStatusBar: vi.fn(),
      onStateChanged: noopSub,
      onPrompt: (prompt: FlowStateView['prompt'] | null) => {
        if (prompt) openerAtPrompt = host.ownerDocument.activeElement;
      },
    };
    createFlowStrip(host, deps).onRepoChanged('/repo');
    await vi.waitFor(() => expect(control()!.textContent).toBe('Start'));
    control()!.click();
    await vi.waitFor(() => expect(openerAtPrompt).toBeTruthy());
    expect(host.contains(openerAtPrompt)).toBe(true);
    expect(openerAtPrompt!.className).toMatch(/flow-control|flow-undo/);
  });

  it('drops a modal submit if the cwd moved to another repo while it was open (§24.2.3 T3)', async () => {
    // The submit binds to the repo the prompt was raised for: a cd away before Confirm must not land
    // the value on the now-current (wrong) repo (§16.3).
    let lastSubmit: ((v: Record<string, string>) => void) | undefined;
    const promptView: FlowStateView = {
      stepName: 'plan', runStarted: 'never-started' as const,
      steps: ['plan'],
      position: 1,
      total: 1,
      status: 'in_progress',
      prompt: { inputs: [{ name: 'ticket', type: 'github-ticket' }], bootstrap: 'agent-loop pickup' },
    };
    const provideInput = vi.fn(async (): Promise<FlowStateView> => ({ ...promptView, prompt: undefined }));
    const deps = {
      state: vi.fn(async (): Promise<FlowStateView> => ({ ...promptView, status: 'not_started' as FlowStatus, prompt: undefined })),
      start: vi.fn(async (): Promise<FlowStateView> => promptView),
      advance: vi.fn(),
      restart: vi.fn(),
      undo: vi.fn(),
      terminate: vi.fn(),
      provideInput,
      onStateChanged: noopSub,
      onStatusBar: vi.fn(),
      onPrompt: (prompt: FlowStateView['prompt'] | null, _stepName: string, submit: (v: Record<string, string>) => void) => {
        if (prompt) lastSubmit = submit;
      },
    };
    const strip = createFlowStrip(host, deps);
    strip.onRepoChanged('/repo');
    await vi.waitFor(() => expect(control()!.textContent).toBe('Start'));
    control()!.click();
    await vi.waitFor(() => expect(lastSubmit).toBeTruthy());

    strip.onRepoChanged('/other');
    await vi.waitFor(() => expect(deps.state).toHaveBeenCalledWith('/other'));
    lastSubmit!({ ticket: '176' });
    expect(provideInput).not.toHaveBeenCalled();
  });

  it('does not open a prompt for the prior repo if the cwd moved during a slow transition', async () => {
    // The handler awaits the transition before opening the prompt: if the cwd moved while start()/advance()
    // was in flight, the awaited view belongs to the old repo and must be dropped (§16.3).
    let resolveStart: (v: FlowStateView) => void = () => {};
    const promptView: FlowStateView = {
      stepName: 'plan', runStarted: 'never-started' as const,
      steps: ['plan'],
      position: 1,
      total: 1,
      status: 'in_progress',
      prompt: { inputs: [{ name: 'ticket', type: 'github-ticket' }], bootstrap: 'agent-loop pickup' },
    };
    const seen: Array<FlowStateView['prompt'] | null> = [];
    const deps = {
      state: vi.fn(async (): Promise<FlowStateView> => ({ ...promptView, status: 'not_started' as FlowStatus, prompt: undefined })),
      start: vi.fn((): Promise<FlowStateView> => new Promise((r) => { resolveStart = r; })),
      advance: vi.fn(),
      restart: vi.fn(),
      undo: vi.fn(),
      terminate: vi.fn(),
      provideInput: vi.fn(),
      onStatusBar: vi.fn(),
      onStateChanged: noopSub,
      onPrompt: (prompt: FlowStateView['prompt'] | null) => seen.push(prompt),
    };
    const strip = createFlowStrip(host, deps);
    strip.onRepoChanged('/repo');
    await vi.waitFor(() => expect(control()!.textContent).toBe('Start'));
    control()!.click(); // start() is now pending
    strip.onRepoChanged('/other'); // cwd moves before start resolves
    await vi.waitFor(() => expect(deps.state).toHaveBeenCalledWith('/other'));

    resolveStart(promptView); // the stale /repo transition finally resolves
    await new Promise((r) => setTimeout(r, 0));
    expect(seen.filter(Boolean)).toHaveLength(0);
  });

  it('drops the modal-submit transition if the cwd moved while provideInput was in-flight', async () => {
    // The post-await guard: even after the pre-call repoKey check, the awaited provideInput response
    // must be dropped if the cwd moved in flight, else a stale transition repaints the wrong repo (§16.3).
    let resolveProvide: (v: FlowStateView) => void = () => {};
    let lastSubmit: ((v: Record<string, string>) => void) | undefined;
    const promptView: FlowStateView = {
      stepName: 'plan', runStarted: 'never-started' as const,
      steps: ['plan'],
      position: 1,
      total: 1,
      status: 'in_progress',
      prompt: { inputs: [{ name: 'ticket', type: 'github-ticket' }], bootstrap: 'agent-loop pickup' },
    };
    const seen: Array<FlowStateView['prompt'] | null> = [];
    const deps = {
      state: vi.fn(async (): Promise<FlowStateView> => ({ ...promptView, status: 'not_started' as FlowStatus, prompt: undefined })),
      start: vi.fn(async (): Promise<FlowStateView> => promptView),
      advance: vi.fn(),
      restart: vi.fn(),
      undo: vi.fn(),
      terminate: vi.fn(),
      provideInput: vi.fn((): Promise<FlowStateView> => new Promise((r) => { resolveProvide = r; })),
      onStateChanged: noopSub,
      onStatusBar: vi.fn(),
      onPrompt: (prompt: FlowStateView['prompt'] | null, _s: string, submit: (v: Record<string, string>) => void) => {
        seen.push(prompt);
        if (prompt) lastSubmit = submit;
      },
    };
    const strip = createFlowStrip(host, deps);
    strip.onRepoChanged('/repo');
    await vi.waitFor(() => expect(control()!.textContent).toBe('Start'));
    control()!.click();
    await vi.waitFor(() => expect(lastSubmit).toBeTruthy());
    const seenBefore = seen.filter(Boolean).length;

    lastSubmit!({ ticket: '176' }); // provideInput now pending for /repo
    expect(deps.provideInput).toHaveBeenCalledWith('/repo', 'plan', { ticket: '176' });
    strip.onRepoChanged('/other'); // cwd moves while provideInput is in flight
    await vi.waitFor(() => expect(deps.state).toHaveBeenCalledWith('/other'));

    resolveProvide({ ...promptView, stepName: 'STALE' });
    await new Promise((r) => setTimeout(r, 0));
    expect(host.textContent).not.toContain('STALE');
    expect(seen.filter(Boolean).length).toBe(seenBefore);
  });

  it('keeps keyboard focus on the rail Loop read-out across a background state push (WCAG 2.4.3)', async () => {
    let fire = (): void => {};
    const loopView: FlowStateView = {
      stepName: 'build', runStarted: 'never-started' as const,
      steps: ['build'],
      position: 1,
      total: 1,
      status: 'in_progress',
      loop: { status: 'awaiting-human-pr-approval', iteration: 9, pr: 179, branch: 'b', ready: false },
    };
    const deps = {
      state: vi.fn(async (): Promise<FlowStateView> => loopView),
      start: vi.fn(),
      advance: vi.fn(),
      restart: vi.fn(),
      undo: vi.fn(),
      terminate: vi.fn(),
      provideInput: vi.fn(),
      onStatusBar: vi.fn(),
      onStateChanged: vi.fn((cb: () => void) => {
        fire = cb;
        return () => {};
      }),
    };
    createFlowStrip(host, deps).onRepoChanged('/repo');
    await vi.waitFor(() => expect(host.querySelector('.loopstat')).not.toBeNull());
    const oldReadout = host.querySelector<HTMLElement>('.loopstat')!;
    oldReadout.focus();
    expect(document.activeElement).toBe(oldReadout);

    fire(); // main pushes flow:onStateChanged → the read-out updates live, with no user action
    await vi.waitFor(() => expect(deps.state.mock.calls.length).toBeGreaterThanOrEqual(2)); // push handled
    expect(document.activeElement).toBe(host.querySelector('.loopstat')); // focus stayed on the read-out (WCAG 2.4.3)
  });

  it('signals onPrompt(null) on a transition with no input prompt, closing the modal (§24.2.3 T3)', async () => {
    const seen: Array<FlowStateView['prompt'] | null> = [];
    const deps = {
      ...fakeFlow('not_started'),
      onPrompt: (prompt: FlowStateView['prompt'] | null) => seen.push(prompt),
    };
    createFlowStrip(host, deps).onRepoChanged('/repo');
    await vi.waitFor(() => expect(control()!.textContent).toBe('Start'));
    control()!.click(); // a prompt-less transition
    await vi.waitFor(() => expect(control()!.textContent).toBe('Advance'));
    expect(seen.at(-1)).toBeNull();
  });

  it('renders a clear --danger error line (no stations, no control) on load failure', async () => {
    const deps = {
      state: vi.fn(
        async (): Promise<FlowStateView> => ({
          stepName: '', runStarted: 'never-started' as const,
          steps: [],
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
      terminate: vi.fn(),
      provideInput: vi.fn(),
      onStatusBar: vi.fn(),
      onStateChanged: noopSub,
    };
    createFlowStrip(host, deps).onRepoChanged('/repo');
    await vi.waitFor(() => expect(host.querySelector('.flow-error')).not.toBeNull());
    expect(host.querySelector<HTMLElement>('.flow-error')!.textContent).toContain('flow.yaml not found');
    expect(stations()).toHaveLength(0);
    expect(control()).toBeNull();
  });

  it('survives a state() IPC rejection on refresh: resolves and keeps the last rendered rail (§18.1)', async () => {
    const deps = fakeFlow('in_progress');
    const strip = createFlowStrip(host, deps);
    strip.onRepoChanged('/repo');
    await vi.waitFor(() => expect(stepName()).toBe('/repo-step'));

    deps.state.mockRejectedValueOnce(new Error('ipc down'));
    await expect(strip.refresh()).resolves.toBeUndefined(); // swallowed, not propagated (§18.1)
    expect(stepName()).toBe('/repo-step'); // prior UI preserved, host not cleared
  });

  it('re-enables a control button when BOTH the action and the refresh() repaint reject (§18.1)', async () => {
    // The in-flight button is disabled, then re-enabled on the catch→refresh path; if state() ALSO
    // rejects, the button must not be stranded disabled — the user can still retry.
    const deps = fakeFlow('in_progress');
    const strip = createFlowStrip(host, deps);
    strip.onRepoChanged('/repo');
    await vi.waitFor(() => expect(control()!.textContent).toBe('Advance'));
    const button = control()!;

    deps.advance.mockRejectedValueOnce(new Error('advance failed'));
    deps.state.mockRejectedValueOnce(new Error('ipc down'));
    button.click();

    await vi.waitFor(() => expect(button.disabled).toBe(false)); // not stranded disabled
  });

  it('dispose() unsubscribes the push handler and clears the host (UI-STANDARDS clean teardown)', async () => {
    let fire = (): void => {};
    const unsubscribe = vi.fn();
    const deps = {
      ...fakeFlow('in_progress'),
      onStateChanged: vi.fn((cb: () => void) => {
        fire = cb;
        return unsubscribe;
      }),
    };
    const strip = createFlowStrip(host, deps);
    strip.onRepoChanged('/repo');
    await vi.waitFor(() => expect(stepName()).toBe('/repo-step'));

    const callsBeforeDispose = deps.state.mock.calls.length;
    strip.dispose();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(host.childElementCount).toBe(0);

    fire(); // a post-dispose push must NOT re-pull or repaint
    await new Promise((r) => setTimeout(r, 0));
    expect(deps.state.mock.calls.length).toBe(callsBeforeDispose);
    expect(host.childElementCount).toBe(0);
  });

  it('builds from host.ownerDocument, not the global document (UI-STANDARDS §3.3)', async () => {
    await assertRendersFromHostDocument(async (h) => {
      const strip = createFlowStrip(h, fakeFlow('in_progress'));
      strip.onRepoChanged('/repo');
      await strip.refresh();
    });
  });

  // Terminate control (#26 AC1/AC2/AC4) — a destructive control wired confirm-then-terminate. It is
  // rendered only when the composition root supplies the onTerminate confirmation seam.
  describe('Terminate control (#26 AC1/AC2/AC4)', () => {
    const terminate = () => host.querySelector<HTMLButtonElement>('.flow-terminate');

    it('is visible while in_progress', async () => {
      const deps = { ...fakeFlow('in_progress'), onTerminate: vi.fn() };
      createFlowStrip(host, deps).onRepoChanged('/repo');
      await vi.waitFor(() => expect(control()!.textContent).toBe('Advance'));
      expect(terminate()).not.toBeNull();
      expect(terminate()!.textContent).toBe('Terminate');
    });

    it('is visible while done', async () => {
      const deps = { ...fakeFlow('done'), onTerminate: vi.fn() };
      createFlowStrip(host, deps).onRepoChanged('/repo');
      await vi.waitFor(() => expect(control()!.textContent).toBe('Restart'));
      expect(terminate()).not.toBeNull();
    });

    it('is absent when the confirmation seam is not wired, even while in_progress (AC2)', async () => {
      createFlowStrip(host, fakeFlow('in_progress')).onRepoChanged('/repo');
      await vi.waitFor(() => expect(control()!.textContent).toBe('Advance'));
      expect(terminate()).toBeNull();
    });

    it('is absent (not in the DOM/accessibility tree) while not_started (AC2)', async () => {
      const deps = { ...fakeFlow('not_started'), onTerminate: vi.fn() };
      createFlowStrip(host, deps).onRepoChanged('/repo');
      await vi.waitFor(() => expect(control()!.textContent).toBe('Start'));
      expect(terminate()).toBeNull();
    });

    it('is absent in the load-error state of a never-started worktree (AC2)', async () => {
      const deps = {
        state: vi.fn(
          async (): Promise<FlowStateView> => ({
            stepName: '', runStarted: 'never-started' as const,
            steps: [],
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
        terminate: vi.fn(),
        provideInput: vi.fn(),
        onStatusBar: vi.fn(),
        onStateChanged: noopSub,
        onTerminate: vi.fn(),
      };
      createFlowStrip(host, deps).onRepoChanged('/repo');
      await vi.waitFor(() => expect(host.querySelector('.flow-error')).not.toBeNull());
      expect(terminate()).toBeNull();
    });

    const heldRun = (runStarted: 'started' | 'indeterminate') => {
      let held = true;
      const view = (): FlowStateView =>
        held
          ? { stepName: '', runStarted, steps: [], position: 0, total: 0, status: 'error', error: "the run's progression state could not be verified" }
          : { stepName: 'red', runStarted: 'never-started', steps: ['red'], position: 1, total: 1, status: 'not_started' };
      return {
        state: vi.fn(async () => view()),
        start: vi.fn(),
        advance: vi.fn(),
        restart: vi.fn(),
        undo: vi.fn(),
        terminate: vi.fn(async () => {
          held = false;
          return view();
        }),
        provideInput: vi.fn(),
        onStatusBar: vi.fn(),
        onStateChanged: noopSub,
        onTerminate: vi.fn((_repoKey: string, confirm: () => void) => confirm()),
      };
    };

    it.each(['started', 'indeterminate'] as const)(
      'is offered on the load-error view of a begun run (runStarted %s), and confirming repaints to not_started',
      async (runStarted) => {
        const deps = heldRun(runStarted);
        createFlowStrip(host, deps).onRepoChanged('/repo');
        await vi.waitFor(() => expect(host.querySelector('.flow-error')).not.toBeNull());
        expect(terminate()).not.toBeNull();

        terminate()!.click();

        await vi.waitFor(() => expect(deps.terminate).toHaveBeenCalledWith('/repo'));
        await vi.waitFor(() => expect(control()!.textContent).toBe('Start'));
      },
    );

    it('a refused Terminate on the load-error view shows its reason and keeps Terminate offered', async () => {
      const deps = heldRun('started');
      deps.terminate = vi.fn(async () => ({
        ...(await deps.state()),
        notice: 'The run could not be terminated: EACCES',
      }));
      createFlowStrip(host, deps).onRepoChanged('/repo');
      await vi.waitFor(() => expect(terminate()).not.toBeNull());

      terminate()!.click();

      await vi.waitFor(() => expect(host.querySelector('.flow-notice')?.textContent).toBe('The run could not be terminated: EACCES'));
      expect(terminate()).not.toBeNull();
    });

    it('routes activation to the confirmation seam with the current repo, before any terminate (AC3 staging)', async () => {
      const onTerminate = vi.fn();
      const deps = { ...fakeFlow('in_progress'), onTerminate };
      createFlowStrip(host, deps).onRepoChanged('/repo');
      await vi.waitFor(() => expect(terminate()).not.toBeNull());
      terminate()!.click();
      expect(onTerminate).toHaveBeenCalledWith('/repo', expect.any(Function));
      expect(deps.terminate).not.toHaveBeenCalled(); // nothing happens until confirm fires
    });

    it('cancel (confirmation never fires confirm) makes no terminate call (AC4)', async () => {
      const onTerminate = vi.fn(); // models a cancelled confirmation: confirm is never invoked
      const deps = { ...fakeFlow('in_progress'), onTerminate };
      createFlowStrip(host, deps).onRepoChanged('/repo');
      await vi.waitFor(() => expect(terminate()).not.toBeNull());
      terminate()!.click();
      await new Promise((r) => setTimeout(r, 0));
      expect(deps.terminate).not.toHaveBeenCalled();
    });

    it('confirming invokes terminate for the repo and repaints to not_started (AC5)', async () => {
      const onTerminate = vi.fn((_repoKey: string, confirm: () => void) => confirm());
      const deps = { ...fakeFlow('in_progress'), onTerminate };
      createFlowStrip(host, deps).onRepoChanged('/repo');
      await vi.waitFor(() => expect(terminate()).not.toBeNull());
      terminate()!.click();
      await vi.waitFor(() => expect(deps.terminate).toHaveBeenCalledWith('/repo'));
      await vi.waitFor(() => expect(control()!.textContent).toBe('Start'));
      expect(terminate()).toBeNull(); // gone in not_started
    });

    it('surfaces a terminate write-failure instead of swallowing it', async () => {
      const onError = vi.fn();
      const onTerminate = vi.fn((_repoKey: string, confirm: () => void) => confirm());
      const deps = {
        ...fakeFlow('in_progress'),
        terminate: vi.fn(async () => { throw new Error('cannot write .agent-terminal/flow-state.yaml'); }),
        onTerminate,
        onError,
      };
      createFlowStrip(host, deps).onRepoChanged('/repo');
      await vi.waitFor(() => expect(terminate()).not.toBeNull());
      terminate()!.click();
      await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
      expect(String(onError.mock.calls[0][0])).toContain('cannot write');
    });

    it('drops a stale confirm if the cwd moved to another repo before confirming (AC11)', async () => {
      let captured: (() => void) | undefined;
      const onTerminate = vi.fn((_repoKey: string, confirm: () => void) => {
        captured = confirm;
      });
      const deps = { ...fakeFlow('in_progress'), onTerminate };
      const strip = createFlowStrip(host, deps);
      strip.onRepoChanged('/repo');
      await vi.waitFor(() => expect(terminate()).not.toBeNull());
      terminate()!.click();
      await vi.waitFor(() => expect(captured).toBeTruthy());

      strip.onRepoChanged('/other');
      await vi.waitFor(() => expect(deps.state).toHaveBeenCalledWith('/other'));
      captured!(); // a late confirm after the cwd moved must not terminate the now-current repo
      expect(deps.terminate).not.toHaveBeenCalled();
    });

    it('after confirming, lands focus on a real control instead of dropping it to <body> (WCAG 2.4.3)', async () => {
      // The repaint to not_started detaches the Terminate button the confirm dialog restored focus to,
      // and not_started carries no prompt, so without a re-anchor focus falls to <body>.
      const onTerminate = vi.fn((_repoKey: string, confirm: () => void) => {
        // Model createModalShell.close() restoring focus to its opener (the Terminate button) before
        // the strip's confirm closure runs.
        host.querySelector<HTMLButtonElement>('.flow-terminate')!.focus();
        confirm();
      });
      const deps = { ...fakeFlow('in_progress'), onTerminate };
      createFlowStrip(host, deps).onRepoChanged('/repo');
      await vi.waitFor(() => expect(terminate()).not.toBeNull());
      terminate()!.click();
      await vi.waitFor(() => expect(control()!.textContent).toBe('Start'));
      expect(document.activeElement).toBe(control());
    });

    it('re-enables the Terminate control if both terminate() and the recovery state() reject (failure recovery)', async () => {
      const onTerminate = vi.fn((_repoKey: string, confirm: () => void) => confirm());
      const deps = { ...fakeFlow('in_progress'), onTerminate };
      createFlowStrip(host, deps).onRepoChanged('/repo');
      await vi.waitFor(() => expect(terminate()).not.toBeNull());
      const button = terminate()!;
      // Make both the terminate call and refresh()'s re-pull reject, so no repaint detaches the
      // button — only the finally re-enable can rescue it from being stranded disabled.
      deps.terminate.mockRejectedValueOnce(new Error('terminate failed'));
      deps.state.mockRejectedValueOnce(new Error('state failed'));
      button.click();
      await vi.waitFor(() => expect(deps.terminate).toHaveBeenCalledWith('/repo'));
      await vi.waitFor(() => expect(button.disabled).toBe(false));
      expect(host.querySelector('.flow-terminate')).toBe(button); // never repainted
    });
  });

  // A passive flow:onStateChanged push (§24.2.2 S5) carries only LIVE-DERIVED change — todo counts,
  // agent activity, the loop's live view — never a structural change (status/steps/controls
  // move only via a user transition). Repainting it by tearing the whole subtree down detaches any
  // node the user (or an open modal) is mid-interaction with: the focused control loses focus to
  // <body>, an in-flight click target keeps detaching so the click never lands, and a confirm
  // dialog's captured opener becomes stale so focus is not restored on close. The push must patch
  // the derived values in place and leave the interactive nodes attached.
  describe('passive push patches in place without tearing down interactive nodes (§24.2.2 S5)', () => {
    const passiveDeps = (read: () => FlowStateView) => {
      let fire = (): void => {};
      const deps = {
        state: vi.fn(async () => read()),
        start: vi.fn(),
        advance: vi.fn(),
        restart: vi.fn(),
        undo: vi.fn(),
        terminate: vi.fn(),
        provideInput: vi.fn(),
        onStatusBar: vi.fn(),
        onStateChanged: vi.fn((cb: () => void) => {
          fire = cb;
          return () => {};
        }),
      };
      return { deps, push: () => fire() };
    };

    it('keeps keyboard focus on the focused control across a derived-only push (1918/WCAG 2.4.3)', async () => {
      let activity: AgentState = 'active';
      const { deps, push } = passiveDeps(() => ({
        stepName: 'build', runStarted: 'never-started' as const,
        steps: ['build'],
        position: 1,
        total: 1,
        status: 'in_progress',
        derived: { activity, todosDone: 1, todosTotal: 3, ready: false },
      }));
      createFlowStrip(host, deps).onRepoChanged('/repo');
      await vi.waitFor(() => expect(control()).not.toBeNull());
      control()!.focus();
      expect(document.activeElement).toBe(control());

      activity = 'quiet';
      push();
      await vi.waitFor(() =>
        expect(host.querySelector<HTMLElement>('.flow-derived')!.textContent!.toLowerCase()).toContain('quiet'),
      );
      expect(document.activeElement).toBe(control()); // never dropped to <body> by a teardown
    });

    it('does not tear down the Terminate control on a derived-only push, so a captured opener stays valid (2475 AC13)', async () => {
      let done = 1;
      const { deps, push } = passiveDeps(() => ({
        stepName: 'build', runStarted: 'never-started' as const,
        steps: ['build'],
        position: 1,
        total: 1,
        status: 'in_progress',
        derived: { activity: 'active', todosDone: done, todosTotal: 3, ready: false },
      }));
      createFlowStrip(host, { ...deps, onTerminate: vi.fn() }).onRepoChanged('/repo');
      await vi.waitFor(() => expect(host.querySelector('.flow-terminate')).not.toBeNull());
      const opener = host.querySelector('.flow-terminate');

      done = 2;
      push();
      await vi.waitFor(() => expect(host.querySelector<HTMLElement>('.flow-derived')!.textContent).toContain('2 / 3'));
      // Same node — a modal that captured this button as its focus-restore opener still resolves it.
      expect(host.querySelector('.flow-terminate')).toBe(opener);
    });

    it('updates the loop read-out iteration in place and keeps the same node across a live re-pull (§24.2.3 T2)', async () => {
      let iteration = 9;
      const { deps, push } = passiveDeps(() => ({
        stepName: 'build', runStarted: 'never-started' as const,
        steps: ['build'],
        position: 1,
        total: 1,
        status: 'in_progress',
        loop: { status: 'awaiting-human-pr-approval', iteration, pr: 179, branch: 'b', ready: false },
      }));
      createFlowStrip(host, { ...deps, loopPanelId: 'loop-panel' }).onRepoChanged('/repo');
      await vi.waitFor(() => expect(host.querySelector('.loopstat')).not.toBeNull());
      const readout = host.querySelector('.loopstat');
      expect(readout!.textContent).toContain('iter 9');

      iteration = 11;
      push();
      await vi.waitFor(() => expect(host.querySelector('.loopstat')!.textContent).toContain('iter 11'));
      // Same node — the click/focus target survives the live re-pull rather than detaching mid-action.
      expect(host.querySelector('.loopstat')).toBe(readout);
    });

    it('still does a full structural render when the push changes structure (loop appears)', async () => {
      let withLoop = false;
      const { deps, push } = passiveDeps(() =>
        withLoop
          ? {
              stepName: 'build', runStarted: 'never-started' as const,
              steps: ['build'],
              position: 1,
              total: 1,
              status: 'in_progress',
              loop: { status: 'impl-review', iteration: 1, pr: 1, branch: 'b', ready: false },
            }
          : {
              stepName: 'build', runStarted: 'never-started' as const,
              steps: ['build'],
              position: 1,
              total: 1,
              status: 'in_progress',
              derived: { activity: 'active', todosDone: 1, todosTotal: 3, ready: false },
            },
      );
      createFlowStrip(host, deps).onRepoChanged('/repo');
      await vi.waitFor(() => expect(host.querySelector('.flow-derived')).not.toBeNull());
      expect(host.querySelector('.loopstat')).toBeNull();

      withLoop = true;
      push();
      await vi.waitFor(() => expect(host.querySelector('.loopstat')).not.toBeNull());
      expect(host.querySelector('.flow-derived')).toBeNull(); // the derived line gave way to the loop read-out
    });
  });

  it('builds the loop read-out from host.ownerDocument too (covers the loopReadout branch, §3.3)', async () => {
    const loopDeps = {
      ...fakeFlow('in_progress'),
      state: vi.fn(
        async (): Promise<FlowStateView> => ({
          stepName: 'build', runStarted: 'never-started' as const,
          steps: ['build'],
          position: 1,
          total: 1,
          status: 'in_progress' as FlowStatus,
          loop: { status: 'impl-review', iteration: 3, pr: 12, branch: 'agent-loop/x', ready: false },
        }),
      ),
    };
    await assertRendersFromHostDocument(async (h) => {
      const strip = createFlowStrip(h, loopDeps);
      strip.onRepoChanged('/repo');
      await strip.refresh();
    });
  });
});

// A2 (#133) §18.7.6 — the display-sanitized degrade reason (a pointer selection that fell back to the default)
// renders as a PERSISTENT element on the running flow view. It is NOT the load `error` (a degrade keeps the
// fallback running, so status is not `error`) and NOT the one-shot `notice` (which clears on the next
// transition) — so it must survive a passive re-pull.
describe('flow selection-reason (§18.7.6 degrade)', () => {
  const reasonView = (selectionReason?: string): FlowStateView => ({
    stepName: 'fallback-step', runStarted: 'never-started' as const,
    steps: ['fallback-step'],
    position: 1,
    total: 1,
    status: 'not_started',
    ...(selectionReason ? { selectionReason } : {}),
  });

  it('paints a persistent selection-reason element on a non-error running view', async () => {
    const deps = { ...fakeFlow(), state: vi.fn(async () => reasonView('Selected flow "x" was not found; running the default flow instead.')) };
    createFlowStrip(host, deps).onRepoChanged('/repo');
    await vi.waitFor(() => expect(host.querySelector('.flow-selection-reason')).not.toBeNull());
    expect(host.querySelector('.flow-selection-reason')!.textContent).toBe(
      'Selected flow "x" was not found; running the default flow instead.',
    );
    // The station rail still renders — a degrade runs the fallback flow, it does not error out.
    expect(host.querySelector('.flow.vert')).not.toBeNull();
    expect(host.querySelector('.flow-error')).toBeNull();
  });

  it('renders no selection-reason element when the view carries none', async () => {
    const deps = { ...fakeFlow(), state: vi.fn(async () => reasonView(undefined)) };
    createFlowStrip(host, deps).onRepoChanged('/repo');
    await vi.waitFor(() => expect(host.querySelector('.flow.vert')).not.toBeNull());
    expect(host.querySelector('.flow-selection-reason')).toBeNull();
  });

  it('keeps the reason across a passive re-pull (persistent, unlike the one-shot notice)', async () => {
    const strip = createFlowStrip(host, {
      ...fakeFlow(),
      state: vi.fn(async () => reasonView('Selected flow degraded; running the default flow instead.')),
    });
    strip.onRepoChanged('/repo');
    await vi.waitFor(() => expect(host.querySelector('.flow-selection-reason')).not.toBeNull());
    await strip.refresh();
    expect(host.querySelector('.flow-selection-reason')!.textContent).toBe(
      'Selected flow degraded; running the default flow instead.',
    );
  });

  it('updates the reason on a passive re-pull when it CHANGES over the same fallback definition', async () => {
    // selectionReason is part of structuralSig, so a changed reason over an otherwise-identical view forces a
    // render rather than the value-only patch path (patchInPlace never touches .flow-selection-reason). Without
    // that sig line the stale reason would linger — this pins the repaint-on-change half of the behavior.
    let reason = 'Selected flow "a" was not found; running the default flow instead.';
    const strip = createFlowStrip(host, { ...fakeFlow(), state: vi.fn(async () => reasonView(reason)) });
    strip.onRepoChanged('/repo');
    await vi.waitFor(() => expect(host.querySelector('.flow-selection-reason')?.textContent).toBe(reason));
    reason = 'Selected flow "b" was not found; running the default flow instead.';
    await strip.refresh();
    expect(host.querySelector('.flow-selection-reason')!.textContent).toBe(reason);
  });
});
