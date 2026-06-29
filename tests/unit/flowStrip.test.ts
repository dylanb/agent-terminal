// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFlowStrip } from '../../src/renderer/src/flowStrip';
import { assertRendersFromHostDocument } from './relocatable';
import { FLOW_CHANGED_EVENT } from '../../src/renderer/src/paneActions';
import type { AgentState, FlowStateView, FlowStatus } from '../../src/shared/ipc';

// §24.2.2 / §24.2.3 T1 / §22.3 — the flow status strip. It follows the cwd: every window.flow call
// must carry the current repoKey, so a stale-repo response must never repaint the rail (§16.3).

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
    terminate: vi.fn(async (repoKey: string) => {
      byKey.set(repoKey, 'not_started');
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
const stepName = () => stations()[1]?.querySelector('.nm')?.textContent ?? ''; // station 0 is the bookend
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
    expect(sect()).toBe('Flow — step 1 / 3'); // synthetic-inclusive: the bookends count toward the total
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
      terminate: vi.fn(),
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

    await strip.refresh(); // state() carries no notice → the one-shot line clears (§24.2.2 S4)
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
      terminate: vi.fn(),
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
      terminate: vi.fn(),
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
      terminate: vi.fn(),
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
      terminate: vi.fn(),
      provideInput: vi.fn(),
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

  it('omits aria-controls on the loop read-out when no panel id is injected (no hard-coded global id)', async () => {
    const deps = {
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
      start: vi.fn(),
      advance: vi.fn(),
      restart: vi.fn(),
      undo: vi.fn(),
      terminate: vi.fn(),
      provideInput: vi.fn(),
      onStateChanged: noopSub,
      // no loopPanelId → the strip must not bake in a document-level id (UI-STANDARDS §2.2 rule 1)
    };
    createFlowStrip(host, deps).onRepoChanged('/repo');
    await vi.waitFor(() => expect(host.querySelector('.loopstat')).not.toBeNull());
    expect(host.querySelector<HTMLElement>('.loopstat')!.hasAttribute('aria-controls')).toBe(false);
  });

  // A focus-landing seam for the composition root (WCAG 2.4.3): the root lands focus via this contract
  // rather than reaching into the strip's private `.loopstat`. The boolean return lets it fall back
  // when no loop is shown.
  describe('focusLoopReadout (focus-landing seam, §24.2.3 T4 / WCAG 2.4.3)', () => {
    const loopDeps = () => ({
      state: vi.fn(
        async (): Promise<FlowStateView> => ({
          stepName: 'build',
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
      terminate: vi.fn(),
      provideInput: vi.fn(),
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
      terminate: vi.fn(),
      provideInput: vi.fn(),
      onStateChanged: noopSub,
      onLoopState: (loop: FlowStateView['loop'] | null, title: string) => seen.push({ status: loop?.status, title }),
    };
    createFlowStrip(host, deps).onRepoChanged('/repo');
    await vi.waitFor(() => expect(seen.some((s) => s.status === 'awaiting-human-pr-approval')).toBe(true));
    expect(seen.at(-1)!.title).toBe('build');
  });

  it('signals onLoopState(null) for a non-loop step so the panel clears and closes', async () => {
    const seen: Array<FlowStateView['loop'] | null> = [];
    const deps = { ...fakeFlow('in_progress'), onLoopState: (loop: FlowStateView['loop'] | null) => seen.push(loop) };
    createFlowStrip(host, deps).onRepoChanged('/repo');
    await vi.waitFor(() => expect(control()!.textContent).toBe('Advance'));
    expect(seen.at(-1)).toBeNull();
  });

  // §24.2.3 T3 — the prompt is transition-driven and one-shot (like `notice`): a passive `state()`
  // re-pull must NOT pop it, else a background flow:onStateChanged refresh reopens the modal under the user.
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
      start: vi.fn(async (): Promise<FlowStateView> => promptView),
      advance: vi.fn(),
      restart: vi.fn(),
      undo: vi.fn(),
      terminate: vi.fn(),
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

    control()!.click();
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
    expect(seen.at(-1)).toEqual({ names: ['ticket'], stepName: 'plan' });

    lastSubmit!({ ticket: '176' });
    expect(provideInput).toHaveBeenCalledWith('/repo', { ticket: '176' });
  });

  it('focuses a real flow control before opening the prompt, so the modal does not capture <body> as opener (WCAG 2.4.3)', async () => {
    // Coupling with flowInputModal: it captures its opener from activeElement on open. The rail rebuild
    // detaches the clicked control (focus → <body>), so the strip must re-anchor focus on a real control
    // BEFORE emitting the prompt, or focus restores to <body> on close.
    let openerAtPrompt: Element | null = null;
    const promptView: FlowStateView = {
      stepName: 'plan',
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
      terminate: vi.fn(),
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
      terminate: vi.fn(),
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
    expect(seen.filter(Boolean)).toHaveLength(0);
  });

  it('drops the modal-submit transition if the cwd moved while provideInput was in-flight', async () => {
    // The post-await guard: even after the pre-call repoKey check, the awaited provideInput response
    // must be dropped if the cwd moved in flight, else a stale transition repaints the wrong repo (§16.3).
    let resolveProvide: (v: FlowStateView) => void = () => {};
    let lastSubmit: ((v: Record<string, string>) => void) | undefined;
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
      start: vi.fn(async (): Promise<FlowStateView> => promptView),
      advance: vi.fn(),
      restart: vi.fn(),
      undo: vi.fn(),
      terminate: vi.fn(),
      provideInput: vi.fn((): Promise<FlowStateView> => new Promise((r) => { resolveProvide = r; })),
      onStateChanged: noopSub,
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
    expect(deps.provideInput).toHaveBeenCalledWith('/repo', { ticket: '176' });
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
      terminate: vi.fn(),
      provideInput: vi.fn(),
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
      terminate: vi.fn(),
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

    it('is absent in the load-error state (AC2)', async () => {
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
        terminate: vi.fn(),
        provideInput: vi.fn(),
        onStateChanged: noopSub,
        onTerminate: vi.fn(),
      };
      createFlowStrip(host, deps).onRepoChanged('/repo');
      await vi.waitFor(() => expect(host.querySelector('.flow-error')).not.toBeNull());
      expect(terminate()).toBeNull();
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
  // agent activity, the loop's state.yaml mirror — never a structural change (status/steps/controls
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
        stepName: 'build',
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
        stepName: 'build',
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
        stepName: 'build',
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
              stepName: 'build',
              steps: ['build'],
              position: 1,
              total: 1,
              status: 'in_progress',
              loop: { status: 'impl-review', iteration: 1, pr: 1, branch: 'b', ready: false },
            }
          : {
              stepName: 'build',
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
