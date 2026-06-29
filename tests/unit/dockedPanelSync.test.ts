// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { syncDockedPanel } from '../../src/renderer/src/dockedPanelSync';
import { createLoopPanel } from '../../src/renderer/src/loopPanel';
import type { FlowLoopView } from '../../src/shared/ipc';

const loop = (over: Partial<FlowLoopView> = {}): FlowLoopView => ({
  status: 'awaiting-human-pr-approval',
  iteration: 9,
  pr: 179,
  branch: 'b',
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

// The composition root routes a flow view's loop/refs to the docked panel. When nothing is left to
// show it must close the panel (which hands focus off the still-present close button) BEFORE clearing
// it — clearing first removes the focused close button and strands focus on <body> (WCAG 2.4.3).
describe('syncDockedPanel', () => {
  it('closes BEFORE clearing the panel, so the close runs while focus is still inside it', () => {
    const panel = createLoopPanel(host);
    panel.render(loop(), 'build');
    host.querySelector<HTMLElement>('[data-loop-close]')!.focus();
    let focusInPanelAtClose: boolean | null = null;
    syncDockedPanel(null, '', undefined, {
      render: (l, t, r) => panel.render(l, t, r),
      closePanel: () => {
        focusInPanelAtClose = host.contains(document.activeElement);
      },
      syncExpanded: vi.fn(),
    });
    expect(focusInPanelAtClose).toBe(true); // close ran before render() removed the focused close button
    expect(host.childElementCount).toBe(0); // and the panel was still cleared
  });

  it('renders content and syncs the read-out without closing when there is content', () => {
    const panel = createLoopPanel(host);
    const closePanel = vi.fn();
    const syncExpanded = vi.fn();
    syncDockedPanel(loop(), 'build', undefined, { render: (l, t, r) => panel.render(l, t, r), closePanel, syncExpanded });
    expect(closePanel).not.toHaveBeenCalled();
    expect(syncExpanded).toHaveBeenCalledTimes(1);
    expect(host.querySelector('.ldl')).not.toBeNull();
  });

  it('treats refs-only (no loop) as content', () => {
    const panel = createLoopPanel(host);
    const closePanel = vi.fn();
    syncDockedPanel(null, 'plan', { ticket: 25 }, { render: (l, t, r) => panel.render(l, t, r), closePanel, syncExpanded: vi.fn() });
    expect(closePanel).not.toHaveBeenCalled();
    expect(host.querySelector('.refs')).not.toBeNull();
  });
});
