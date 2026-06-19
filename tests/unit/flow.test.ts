// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SAMPLE_FLOW, createGatePanel, type FlowState } from '../../src/renderer/src/flow';

// §19.3 mocked widget: the view-3 gate panel renders from ONE fixture flow-state. Gate
// actions are stubbed (no real loop-command injection yet) but observably reflect a
// verdict. Tests assert rendered output and the stub's observable effect, never
// internals. The fixture flow timeline + rail status were retired by §24.2.2 S1.

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
