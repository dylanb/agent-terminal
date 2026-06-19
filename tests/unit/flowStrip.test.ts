// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFlowStrip } from '../../src/renderer/src/flowStrip';
import type { FlowStateView, FlowStatus } from '../../src/shared/ipc';

// §24.2.2 / §22.3 — the flow status strip renders with 100% fidelity to the §24.1 mockup
// (design/shell/converged.html): a `Flow — step N / M` header + a vertical station rail
// (`.flow.vert` → `.stn` with circle `.o` + name `.nm`). The rail brackets the real step with
// two synthetic stations — "Not started" (active before the flow starts) and "Completed"
// (active once it finishes) — so the rail is always [Not started] · <step> · [Completed].
// The control follows the lifecycle: Start → Advance → Restart (re-running the step). A load
// failure renders as a single `--danger` text line (the one mockup-gap, by decision).
// Tests assert only rendered DOM + which dep method a click invokes.

function fakeFlow(initial: FlowStatus = 'not_started') {
  let status = initial;
  const view = (): FlowStateView => ({ stepName: 'Manual step', position: 1, total: 1, status });
  return {
    state: vi.fn(async () => view()),
    start: vi.fn(async () => {
      status = 'in_progress';
      return view();
    }),
    advance: vi.fn(async () => {
      status = 'done';
      return view();
    }),
    restart: vi.fn(async () => {
      status = 'in_progress';
      return view();
    }),
  };
}

let host: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = '<div id="host"></div>';
  host = document.getElementById('host')!;
});
afterEach(() => {
  document.body.innerHTML = '';
});

const sect = () => host.querySelector('.sect')!.textContent ?? '';
const stations = () => [...host.querySelectorAll<HTMLElement>('.flow.vert .stn')];
const names = () => stations().map((s) => s.querySelector('.nm')!.textContent);
const stateOf = (i: number) => {
  const cl = stations()[i].classList;
  return cl.contains('active') ? 'active' : cl.contains('done') ? 'done' : 'todo';
};
const control = () => host.querySelector<HTMLButtonElement>('.flow-control');

describe('flow status strip (§22.3 / §24.2.2)', () => {
  it('brackets the real step with synthetic Not-started / Completed stations', async () => {
    await createFlowStrip(host, fakeFlow()).refresh();
    expect(names()).toEqual(['Not started', 'Manual step', 'Completed']);
  });

  it('not_started: the synthetic Not-started station is active; control is Start', async () => {
    await createFlowStrip(host, fakeFlow()).refresh();
    expect(sect()).toBe('Flow — step 1 / 3');
    expect([stateOf(0), stateOf(1), stateOf(2)]).toEqual(['active', 'todo', 'todo']);
    expect(host.querySelector('.flow.vert .stn .o')).not.toBeNull(); // station circles
    expect(control()!.textContent).toBe('Start');
  });

  it('in_progress: the real step station is active; control is Advance', async () => {
    await createFlowStrip(host, fakeFlow('in_progress')).refresh();
    expect(sect()).toBe('Flow — step 2 / 3');
    expect([stateOf(0), stateOf(1), stateOf(2)]).toEqual(['done', 'active', 'todo']);
    expect(control()!.textContent).toBe('Advance');
  });

  it('done: the synthetic Completed station is active; control reappears as Restart', async () => {
    await createFlowStrip(host, fakeFlow('done')).refresh();
    expect(sect()).toBe('Flow — step 3 / 3');
    expect([stateOf(0), stateOf(1), stateOf(2)]).toEqual(['done', 'done', 'active']);
    expect(control()!.textContent).toBe('Restart');
  });

  it('Start invokes start() and moves the real step to active with an Advance control', async () => {
    const deps = fakeFlow();
    await createFlowStrip(host, deps).refresh();
    control()!.click();
    await vi.waitFor(() => expect(stateOf(1)).toBe('active'));
    expect(deps.start).toHaveBeenCalledTimes(1);
    expect(control()!.textContent).toBe('Advance');
  });

  it('Advance from in progress completes the flow (Completed active) and shows Restart', async () => {
    const deps = fakeFlow('in_progress');
    await createFlowStrip(host, deps).refresh();
    control()!.click();
    await vi.waitFor(() => expect(stateOf(2)).toBe('active'));
    expect(deps.advance).toHaveBeenCalledTimes(1);
    expect(control()!.textContent).toBe('Restart');
  });

  it('Restart from done invokes restart() and re-runs the step (active) with an Advance control', async () => {
    const deps = fakeFlow('done');
    await createFlowStrip(host, deps).refresh();
    expect(control()!.textContent).toBe('Restart');
    control()!.click();
    await vi.waitFor(() => expect(stateOf(1)).toBe('active'));
    expect(deps.restart).toHaveBeenCalledTimes(1);
    expect(control()!.textContent).toBe('Advance');
  });

  it('renders a clear --danger error line (the reason, no stations, no control) on load failure (§24.2.2 S2)', async () => {
    const deps = {
      state: vi.fn(
        async (): Promise<FlowStateView> => ({
          stepName: '',
          position: 0,
          total: 0,
          status: 'error',
          error: 'flow.yaml not found',
        }),
      ),
      start: vi.fn(),
      advance: vi.fn(),
      restart: vi.fn(),
    };
    await createFlowStrip(host, deps).refresh();
    const err = host.querySelector<HTMLElement>('.flow-error')!;
    expect(err.textContent).toContain('flow.yaml not found');
    expect(sect()).toBe('Flow'); // header with no position when there is no step
    expect(stations()).toHaveLength(0);
    expect(control()).toBeNull();
  });
});
