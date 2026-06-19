// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFlowStrip } from '../../src/renderer/src/flowStrip';
import type { FlowStateView, FlowStatus } from '../../src/shared/ipc';

// §24.2.2 S1 — the status strip widget: renders `position/total · name` + the live
// status, and a single control that is Start in not_started, Advance in in_progress,
// and gone in done. Tests drive it through its injected flow dep (the IPC seam) and
// assert only the rendered DOM + which dep method a click invokes.

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

const pos = () => host.querySelector('.flow-pos')!.textContent ?? '';
const statusText = () => host.querySelector('.flow-status')!.textContent ?? '';
const control = () => host.querySelector<HTMLButtonElement>('.flow-control');

describe('flow status strip (§24.2.2 S1)', () => {
  it('renders position/total · step name and not-started status with a Start control', async () => {
    const deps = fakeFlow();
    await createFlowStrip(host, deps).refresh();
    expect(pos()).toContain('1/1');
    expect(pos()).toContain('Manual step');
    expect(statusText()).toBe('not started');
    expect(control()!.textContent).toBe('Start');
  });

  it('Start invokes start() and moves the strip to in progress with an Advance control', async () => {
    const deps = fakeFlow();
    await createFlowStrip(host, deps).refresh();
    control()!.click();
    await vi.waitFor(() => expect(statusText()).toBe('in progress'));
    expect(deps.start).toHaveBeenCalledTimes(1);
    expect(control()!.textContent).toBe('Advance');
  });

  it('Advance from in progress completes the flow and removes the control', async () => {
    const deps = fakeFlow('in_progress');
    await createFlowStrip(host, deps).refresh();
    expect(control()!.textContent).toBe('Advance');
    control()!.click();
    await vi.waitFor(() => expect(statusText()).toBe('done'));
    expect(deps.advance).toHaveBeenCalledTimes(1);
    expect(control()).toBeNull();
  });

  it('renders a clear error state (the reason, no control) when the definition failed to load (§24.2.2 S2)', async () => {
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
    };
    await createFlowStrip(host, deps).refresh();
    const st = host.querySelector<HTMLElement>('.flow-status')!;
    expect(st.dataset.status).toBe('error');
    expect(st.textContent).toContain('flow.yaml not found');
    expect(control()).toBeNull();
  });
});
