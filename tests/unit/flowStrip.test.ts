// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFlowStrip } from '../../src/renderer/src/flowStrip';
import { assertRendersFromHostDocument } from './relocatable';
import { FLOW_CHANGED_EVENT } from '../../src/renderer/src/paneActions';
import type { FlowStateView, FlowStatus } from '../../src/shared/ipc';

// §24.2.2 / §24.2.3 T1 / §22.3 — the flow status strip renders the §24.1 mockup station rail: the
// real steps bracketed by two synthetic bookend stations, "Not started" (active before the flow
// starts) and "Completed" (active once it finishes), so the rail reads [Not started] · step₁ · …
// · stepₙ · [Completed] (§24.2.3 T1 generalized the bookends across N real steps). Control is
// Start → Advance → Restart. It FOLLOWS THE CWD: it holds the current repoKey and re-pulls/re-renders
// on `onRepoChanged`, threading that key into every window.flow call (mirroring the repo-scoped todo
// list). Before a repo key is known it renders nothing. Tests assert rendered DOM + the repoKey
// threaded into the dep calls.

function fakeFlow(initial: FlowStatus = 'not_started') {
  const byKey = new Map<string, FlowStatus>();
  const view = (repoKey: string): FlowStateView => {
    const status = byKey.get(repoKey) ?? initial;
    return { stepName: `${repoKey}-step`, steps: [`${repoKey}-step`], position: 1, total: 1, status };
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
    provideInput: vi.fn(async (repoKey: string) => view(repoKey)),
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
const stepName = () => stations()[1]?.querySelector('.nm')?.textContent ?? ''; // station 1 = the first real step (bookend at 0)
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
    expect([stateOf(0), stateOf(1), stateOf(2)]).toEqual(['active', 'todo', 'todo']); // Not started active
    expect(sect()).toBe('Flow — step 1 / 3'); // synthetic-inclusive position
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
    await vi.waitFor(() => expect(stateOf(2)).toBe('active')); // synthetic "Completed" active
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
      steps: ['/repo-step'],
      position: 1,
      total: 1,
      status: 'in_progress',
      notice: 'agent is busy — wait or interrupt, then retry',
    };
    const deps = {
      state: vi.fn(
        async (): Promise<FlowStateView> => ({ stepName: '/repo-step', steps: ['/repo-step'], position: 1, total: 1, status: 'not_started' }),
      ),
      start: vi.fn(async (): Promise<FlowStateView> => notified),
      advance: vi.fn(),
      restart: vi.fn(),
      undo: vi.fn(),
      provideInput: vi.fn(),
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
      provideInput: vi.fn(),
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
      provideInput: vi.fn(),
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
    // The multi-step rail: the real steps sit between the two synthetic bookends — steps before the
    // current one are done, the current one active, later ones todo; the header walks the
    // synthetic-inclusive sequence (so working step 2 of 3 reads 3 / 5).
    const deps = {
      state: vi.fn(
        async (): Promise<FlowStateView> => ({
          stepName: 'plan',
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
      provideInput: vi.fn(),
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
      'done', // Not started — the flow has begun
      'done', // groom — already passed
      'active', // plan — current
      'todo', // implement — ahead
      'todo', // Completed — not yet
    ]);
    expect(sect()).toBe('Flow — step 3 / 5'); // synthetic-inclusive position
    expect(control()!.textContent).toBe('Advance');
  });

  it('renders the compact Loop read-out (tone label + iteration) that opens the docked panel (§24.2.3 T2)', async () => {
    const deps = {
      state: vi.fn(
        async (): Promise<FlowStateView> => ({
          stepName: 'build',
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
      provideInput: vi.fn(),
      onStateChanged: noopSub,
    };
    createFlowStrip(host, deps).onRepoChanged('/repo');
    await vi.waitFor(() => expect(host.querySelector('#loopstat')).not.toBeNull());
    const readout = host.querySelector<HTMLElement>('#loopstat')!;
    expect(readout.getAttribute('role')).toBe('button'); // a keyboard-reachable open control
    expect(readout.getAttribute('aria-controls')).toBe('loop-panel');
    const pill = readout.querySelector<HTMLElement>('.spill')!;
    expect(pill.classList.contains('await')).toBe(true); // awaiting-human → needs-you tone
    expect(pill.textContent).toContain('awaiting'); // the compact tone label, not the full status
    expect(readout.textContent).toContain('iter 9');
    // The exact status/pr/branch live in the docked panel, not the compact read-out.
    expect(readout.textContent).not.toContain('#179');
  });

  it('maps an arbitrary per-LoopDef status onto one of three tones (await/work/settle)', async () => {
    const make = (status: string) => ({
      state: vi.fn(
        async (): Promise<FlowStateView> => ({
          stepName: 'build',
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
      provideInput: vi.fn(),
      onStateChanged: noopSub,
    });
    const toneFor = async (status: string): Promise<string> => {
      host.replaceChildren();
      createFlowStrip(host, make(status)).onRepoChanged('/repo');
      await vi.waitFor(() => expect(host.querySelector('#loopstat .spill')).not.toBeNull());
      const cl = host.querySelector<HTMLElement>('#loopstat .spill')!.classList;
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
    expect(host.querySelector('#loopstat')).toBeNull();
  });

  it('hands the loop mirror to the composition root via onLoopState, for the docked panel (§24.2.3 T2)', async () => {
    const seen: Array<{ status?: string; title: string }> = [];
    const loopView: FlowStateView = {
      stepName: 'build',
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
      provideInput: vi.fn(),
      onStateChanged: noopSub,
      onLoopState: (loop: FlowStateView['loop'] | null, title: string) => seen.push({ status: loop?.status, title }),
    };
    createFlowStrip(host, deps).onRepoChanged('/repo');
    await vi.waitFor(() => expect(seen.some((s) => s.status === 'awaiting-human-pr-approval')).toBe(true));
    expect(seen.at(-1)!.title).toBe('build'); // the panel is told which loop step it mirrors
  });

  it('signals onLoopState(null) for a non-loop step so the panel clears and closes', async () => {
    const seen: Array<FlowStateView['loop'] | null> = [];
    const deps = { ...fakeFlow('in_progress'), onLoopState: (loop: FlowStateView['loop'] | null) => seen.push(loop) };
    createFlowStrip(host, deps).onRepoChanged('/repo');
    await vi.waitFor(() => expect(control()!.textContent).toBe('Advance'));
    expect(seen.at(-1)).toBeNull();
  });

  // §24.2.3 T3 — when a TRANSITION response carries an input `prompt`, the strip hands it to the
  // composition root via `onPrompt` (the contract seam, not a DOM reach-across), along with a
  // `submit` that calls provideInput for the current repo. The prompt is transition-driven (one-shot,
  // like `notice`): a passive `state()` re-pull must NOT pop it (a flow:onStateChanged refresh would
  // otherwise reopen/close the modal under the user).
  it('hands a step-entry input prompt to the composition root on a transition, and submit calls provideInput (§24.2.3 T3)', async () => {
    const seen: Array<{ names: string[]; stepName: string }> = [];
    let lastSubmit: ((v: Record<string, string>) => void) | undefined;
    const promptView: FlowStateView = {
      stepName: 'plan',
      steps: ['plan'],
      position: 1,
      total: 1,
      status: 'in_progress',
      prompt: { inputs: [{ name: 'ticket', type: 'github-ticket' }], bootstrap: 'agent-loop pickup' },
    };
    const provideInput = vi.fn(async (): Promise<FlowStateView> => ({ ...promptView, prompt: undefined, notice: 'booted' }));
    const deps = {
      state: vi.fn(async (): Promise<FlowStateView> => ({ ...promptView, status: 'not_started', prompt: undefined })),
      start: vi.fn(async (): Promise<FlowStateView> => promptView), // Start enters the step → prompt
      advance: vi.fn(),
      restart: vi.fn(),
      undo: vi.fn(),
      provideInput,
      onStateChanged: noopSub,
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

    control()!.click(); // Start = the transition into the step that needs the input
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
    expect(seen.at(-1)).toEqual({ names: ['ticket'], stepName: 'plan' });

    lastSubmit!({ ticket: '176' });
    expect(provideInput).toHaveBeenCalledWith('/repo', { ticket: '176' });
  });

  it('drops a modal submit if the cwd moved to another repo while it was open (§24.2.3 T3)', async () => {
    // The modal binds its submit to the repo the prompt was raised for; if the agent cd's away while
    // the modal is open, Confirm must not land the value on the now-current (wrong) repo.
    let lastSubmit: ((v: Record<string, string>) => void) | undefined;
    const promptView: FlowStateView = {
      stepName: 'plan',
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
      provideInput,
      onStateChanged: noopSub,
      onPrompt: (prompt: FlowStateView['prompt'] | null, _stepName: string, submit: (v: Record<string, string>) => void) => {
        if (prompt) lastSubmit = submit;
      },
    };
    const strip = createFlowStrip(host, deps);
    strip.onRepoChanged('/repo');
    await vi.waitFor(() => expect(control()!.textContent).toBe('Start'));
    control()!.click();
    await vi.waitFor(() => expect(lastSubmit).toBeTruthy());

    strip.onRepoChanged('/other'); // cwd moves while the modal is open
    await vi.waitFor(() => expect(deps.state).toHaveBeenCalledWith('/other'));
    lastSubmit!({ ticket: '176' });
    expect(provideInput).not.toHaveBeenCalled();
  });

  it('does not open a prompt for the prior repo if the cwd moved during a slow transition', async () => {
    // The control handler awaits the transition, then renders/opens-prompt; if the cwd moved while
    // start()/advance() was in flight, the awaited view belongs to the old repo and must be dropped.
    let resolveStart: (v: FlowStateView) => void = () => {};
    const promptView: FlowStateView = {
      stepName: 'plan',
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
      provideInput: vi.fn(),
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
    expect(seen.filter(Boolean)).toHaveLength(0); // no prompt opened for the prior repo
  });

  it('keeps keyboard focus on the rail Loop read-out across a background state push (WCAG 2.4.3)', async () => {
    let fire = (): void => {};
    const loopView: FlowStateView = {
      stepName: 'build',
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
      provideInput: vi.fn(),
      onStateChanged: vi.fn((cb: () => void) => {
        fire = cb;
        return () => {};
      }),
    };
    createFlowStrip(host, deps).onRepoChanged('/repo');
    await vi.waitFor(() => expect(host.querySelector('#loopstat')).not.toBeNull());
    const oldReadout = host.querySelector<HTMLElement>('#loopstat')!;
    oldReadout.focus();
    expect(document.activeElement).toBe(oldReadout);

    fire(); // main pushes flow:onStateChanged → the strip repaints the whole rail, rebuilding #loopstat
    await vi.waitFor(() => expect(host.querySelector('#loopstat')).not.toBe(oldReadout)); // repaint landed
    expect(document.activeElement).toBe(host.querySelector('#loopstat')); // focus rode the repaint
  });

  it('signals onPrompt(null) on a transition with no input prompt, closing the modal (§24.2.3 T3)', async () => {
    const seen: Array<FlowStateView['prompt'] | null> = [];
    const deps = {
      ...fakeFlow('not_started'),
      onPrompt: (prompt: FlowStateView['prompt'] | null) => seen.push(prompt),
    };
    createFlowStrip(host, deps).onRepoChanged('/repo');
    await vi.waitFor(() => expect(control()!.textContent).toBe('Start'));
    control()!.click(); // Start → in_progress, a prompt-less transition
    await vi.waitFor(() => expect(control()!.textContent).toBe('Advance'));
    expect(seen.at(-1)).toBeNull();
  });

  it('renders a clear --danger error line (no stations, no control) on load failure', async () => {
    const deps = {
      state: vi.fn(
        async (): Promise<FlowStateView> => ({
          stepName: '',
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
      provideInput: vi.fn(),
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
    await vi.waitFor(() => expect(stepName()).toBe('/repo-step')); // a good render is on screen

    deps.state.mockRejectedValueOnce(new Error('ipc down')); // the next pull fails
    await expect(strip.refresh()).resolves.toBeUndefined(); // the rejection is swallowed, not propagated
    expect(stepName()).toBe('/repo-step'); // the prior UI is preserved, host not cleared
  });

  it('builds from host.ownerDocument, not the global document (UI-STANDARDS §3.3)', async () => {
    await assertRendersFromHostDocument(async (h) => {
      const strip = createFlowStrip(h, fakeFlow('in_progress'));
      strip.onRepoChanged('/repo');
      await strip.refresh();
    });
  });

  it('builds the loop read-out from host.ownerDocument too (covers the loopReadout branch, §3.3)', async () => {
    const loopDeps = {
      ...fakeFlow('in_progress'),
      state: vi.fn(
        async (): Promise<FlowStateView> => ({
          stepName: 'build',
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
