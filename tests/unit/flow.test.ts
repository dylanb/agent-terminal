// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SAMPLE_FLOW,
  flowLabel,
  renderFlow,
  renderRailStatus,
  createGatePanel,
  type FlowState,
  type FlowStep,
} from '../../src/renderer/src/flow';

// §24.1 mocked widgets: the flow timeline (§19.2), rail gate/loop status, and the
// view-3 gate panel (§19.3) all render from ONE fixture flow-state. Gate actions are
// stubbed (no real loop-command injection yet) but observably reflect a verdict.
// Tests assert rendered output and the stub's observable effect, never internals.

function fixture(over: Partial<FlowState> = {}): FlowState {
  return {
    steps: [
      { name: 'Plan', status: 'done' },
      { name: 'Code', status: 'done' },
      { name: 'Review', status: 'active' },
      { name: 'Ship', status: 'todo' },
    ],
    gate: { label: 'Review gate', status: 'awaiting', note: 'Review came back' },
    loop: { iteration: 3, severity: 'high', openFindings: 2, lastVerdict: 'changes requested' },
    ...over,
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

describe('flow timeline (§19.2)', () => {
  it('renders one station per step with its status class, in order', () => {
    renderFlow(host, fixture().steps);
    const stns = host.querySelectorAll('.stn');
    expect([...stns].map((s) => s.querySelector('.nm')!.textContent)).toEqual(['Plan', 'Code', 'Review', 'Ship']);
    expect(stns[0].classList.contains('done')).toBe(true);
    expect(stns[2].classList.contains('active')).toBe(true);
    expect(stns[3].classList.contains('todo')).toBe(true);
  });

  it('builds nodes from the host document, not the global one (relocatability invariant)', () => {
    const otherDoc = document.implementation.createHTMLDocument('other');
    const otherHost = otherDoc.createElement('div');
    const globalCreate = vi.spyOn(document, 'createElement');
    renderFlow(otherHost, fixture().steps);
    expect(otherHost.querySelector('.stn')).toBeTruthy(); // nodes were built…
    expect(globalCreate).not.toHaveBeenCalled(); // …via otherDoc, never the global document
  });

  it('puts a connector between stations but not after the last', () => {
    renderFlow(host, fixture().steps);
    expect(host.querySelectorAll('.seg').length).toBe(3);
  });

  it('labels the active step position', () => {
    expect(flowLabel(fixture().steps)).toBe('step 3 / 4');
  });

  it('clamps an all-todo flow to step 1 / N (never step 0)', () => {
    const steps: FlowStep[] = [
      { name: 'A', status: 'todo' },
      { name: 'B', status: 'todo' },
    ];
    expect(flowLabel(steps)).toBe('step 1 / 2');
  });

  it('with no active step, points at the next step after the done prefix', () => {
    const steps: FlowStep[] = [
      { name: 'A', status: 'done' },
      { name: 'B', status: 'todo' },
      { name: 'C', status: 'todo' },
    ];
    expect(flowLabel(steps)).toBe('step 2 / 3');
  });

  it('caps at the last step when every step is done', () => {
    const steps: FlowStep[] = [
      { name: 'A', status: 'done' },
      { name: 'B', status: 'done' },
    ];
    expect(flowLabel(steps)).toBe('step 2 / 2');
  });

  it('counts only the done PREFIX, not done steps after the first todo', () => {
    const steps: FlowStep[] = [
      { name: 'A', status: 'done' },
      { name: 'B', status: 'todo' },
      { name: 'C', status: 'done' },
    ];
    expect(flowLabel(steps)).toBe('step 2 / 3'); // next after the leading done, not done-count+1 (=3)
  });

  it('reads "step 0 / 0" for an empty flow (the sole degenerate case; index ≥ 1 for any M > 0)', () => {
    expect(flowLabel([])).toBe('step 0 / 0');
  });
});

describe('rail gate/loop status', () => {
  it('shows the gate state and loop summary from the fixture', () => {
    renderRailStatus(host, fixture());
    expect(host.textContent).toContain('awaiting');
    expect(host.textContent).toContain('iter 03');
    expect(host.textContent).toContain('2 open');
  });
});

describe('view-3 gate panel (§19.3 — clickable, stubbed)', () => {
  it('renders the three controls and the loop table from the fixture', () => {
    createGatePanel(host, fixture());
    expect(host.querySelector('button.app')!.textContent).toContain('Approve');
    expect(host.querySelector('button.send')!.textContent).toContain('Request changes');
    expect(host.textContent).toContain('changes requested');
  });

  it('marks the severity row "bad" only for high/critical severity, reflecting the data', () => {
    const sevLv = (h: HTMLElement): HTMLElement => {
      const r = [...h.querySelectorAll('.lrow')].find((x) => x.querySelector('.lk')?.textContent === 'severity cycle')!;
      return r.querySelector('.lv') as HTMLElement;
    };
    const high = document.createElement('div');
    createGatePanel(high, fixture({ loop: { iteration: 1, severity: 'high', openFindings: 0, lastVerdict: 'x' } }));
    expect(sevLv(high).classList.contains('bad')).toBe(true);

    const low = document.createElement('div');
    createGatePanel(low, fixture({ loop: { iteration: 1, severity: 'low', openFindings: 0, lastVerdict: 'x' } }));
    expect(sevLv(low).classList.contains('bad')).toBe(false);
  });

  it('renders "Open report" disabled (a Phase-1 stub with no behavior must not look actionable)', () => {
    createGatePanel(host, fixture());
    const open = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Open report');
    expect(open).toBeTruthy();
    expect((open as HTMLButtonElement).disabled).toBe(true);
  });

  it('approving reflects the verdict and calls the stub handler (no injection)', () => {
    const onAct = vi.fn();
    const panel = createGatePanel(host, fixture(), { onAct });
    (host.querySelector('button.app') as HTMLButtonElement).click();
    expect(onAct).toHaveBeenCalledWith('approve');
    expect(panel.getStatus()).toBe('approved');
    expect(host.textContent).toContain('approved');
  });

  it('requesting changes reflects that verdict', () => {
    const panel = createGatePanel(host, fixture());
    (host.querySelector('button.send') as HTMLButtonElement).click();
    expect(panel.getStatus()).toBe('changes');
  });
});

describe('SAMPLE_FLOW fixture', () => {
  it('is a coherent in-progress review flow', () => {
    expect(SAMPLE_FLOW.steps.some((s) => s.status === 'active')).toBe(true);
    expect(SAMPLE_FLOW.gate.status).toBe('awaiting');
  });
});
