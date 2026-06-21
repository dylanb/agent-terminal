// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLoopPanel } from '../../src/renderer/src/loopPanel';
import { assertRendersFromHostDocument } from './relocatable';
import type { FlowLoopView } from '../../src/shared/ipc';

// §24.2.3 T2 — the docked loop panel organism (UI-STANDARDS §1.2): the EXPANDED read-only state
// mirror that the rail's compact Loop read-out opens. It renders the real v4 `state.yaml` vocabulary
// (status / iteration / pr / branch) at 100% fidelity to design/shell/loop-flow.html's State section.
// (The gate decision section + LoopDef gate options are T5/T6.) It is placement-agnostic: it touches
// only its host subtree and renders identically wherever it is mounted. Tests assert rendered DOM.

const loop = (over: Partial<FlowLoopView> = {}): FlowLoopView => ({
  status: 'awaiting-human-pr-approval',
  iteration: 9,
  pr: 179,
  branch: 'agent-loop/issue-176',
  ready: false,
  ...over,
});

let host: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = '<aside id="loop-panel"></aside>';
  host = document.getElementById('loop-panel')!;
});
afterEach(() => {
  document.body.innerHTML = '';
});

const row = (key: string): HTMLElement | undefined =>
  [...host.querySelectorAll<HTMLElement>('.ldl .lrow')].find((r) => r.querySelector('.lk')?.textContent === key);

describe('docked loop panel (§24.2.3 T2)', () => {
  it('renders the v4 state mirror rows from the loop view', () => {
    createLoopPanel(host).render(loop(), 'build');
    expect(row('status')?.querySelector('.lv')?.textContent).toBe('awaiting-human-pr-approval');
    expect(row('iteration')?.querySelector('.lv')?.textContent).toBe('9');
    expect(row('pr')?.querySelector('.lv')?.textContent).toBe('#179');
    expect(row('branch')?.querySelector('.lv')?.textContent).toBe('agent-loop/issue-176');
  });

  it('renders the panel header title + a close button the shell can dismiss', () => {
    createLoopPanel(host).render(loop(), 'build');
    expect(host.querySelector('.lhead h3')?.textContent).toBe('build');
    expect(host.querySelector('#lclose')).not.toBeNull();
  });

  it('flags an awaiting-human status as needs-you (the §22.3 act tone)', () => {
    createLoopPanel(host).render(loop({ status: 'awaiting-human-pr-approval' }), 'build');
    expect(row('status')?.querySelector('.lv')?.classList.contains('bad')).toBe(true);
    createLoopPanel(host).render(loop({ status: 'awaiting-team-review' }), 'build'); // past the human
    expect(row('status')?.querySelector('.lv')?.classList.contains('bad')).toBe(false);
  });

  it('renders the gate options row from the gate\'s human_options (request-changes → changes)', () => {
    createLoopPanel(host).render(loop({ gateOptions: ['approve', 'request-changes', 'impasse'] }), 'build');
    expect(row('gate options')?.querySelector('.lv')?.textContent).toBe('approve · changes · impasse');
  });

  it('omits the gate options row at a terminal / non-gate status (no options to offer)', () => {
    createLoopPanel(host).render(loop({ status: 'awaiting-team-review', ready: true }), 'build'); // no gateOptions
    expect(row('gate options')).toBeUndefined();
  });

  it('omits the pr / branch rows when the loop has no PR yet (plan phase)', () => {
    createLoopPanel(host).render(loop({ pr: null, branch: null }), 'plan');
    expect(row('status')).toBeTruthy();
    expect(row('iteration')).toBeTruthy();
    expect(row('pr')).toBeUndefined();
    expect(row('branch')).toBeUndefined();
  });

  it('clears the host when there is no loop state', () => {
    const panel = createLoopPanel(host);
    panel.render(loop(), 'build');
    panel.render(null, '');
    expect(host.childElementCount).toBe(0);
  });

  it('dispose() leaves nothing behind: the host is emptied (UI-STANDARDS clean teardown)', () => {
    const panel = createLoopPanel(host);
    panel.render(loop(), 'build');
    expect(host.childElementCount).toBeGreaterThan(0);
    panel.dispose();
    expect(host.childElementCount).toBe(0);
  });

  it('relocates unchanged: identical render in two different hosts (UI-STANDARDS organism rule)', () => {
    const a = document.createElement('aside');
    const b = document.createElement('aside');
    createLoopPanel(a).render(loop(), 'build');
    createLoopPanel(b).render(loop(), 'build');
    expect(a.innerHTML).toBe(b.innerHTML);
  });

  it('builds from host.ownerDocument, not the global document (UI-STANDARDS §3.3)', async () => {
    await assertRendersFromHostDocument((h) => createLoopPanel(h).render(loop(), 'build'));
  });
});
