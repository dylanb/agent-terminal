// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { syncDockedPanel } from '../../src/renderer/src/dockedPanelSync';
import { createLoopPanel } from '../../src/renderer/src/loopPanel';
import type { FlowLoopView, FlowTokensView } from '../../src/shared/ipc';
import { RUN_TOTAL_ROW, panelTokenTablesIn, tokenCellIn } from '../helpers/tokenCountsUi';

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
    syncDockedPanel(null, '', undefined, undefined, {
      render: (l, t, r, k) => panel.render(l, t, r, k),
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
    syncDockedPanel(loop(), 'build', undefined, undefined, { render: (l, t, r, k) => panel.render(l, t, r, k), closePanel, syncExpanded });
    expect(closePanel).not.toHaveBeenCalled();
    expect(syncExpanded).toHaveBeenCalledTimes(1);
    expect(host.querySelector('.ldl')).not.toBeNull();
  });

  it('treats refs-only (no loop) as content', () => {
    const panel = createLoopPanel(host);
    const closePanel = vi.fn();
    syncDockedPanel(null, 'plan', { ticket: 25 }, undefined, { render: (l, t, r, k) => panel.render(l, t, r, k), closePanel, syncExpanded: vi.fn() });
    expect(closePanel).not.toHaveBeenCalled();
    expect(host.querySelector('.refs')).not.toBeNull();
  });

  const TOKENS: { steps: string[]; tokens: FlowTokensView } = {
    steps: ['plan', 'build'],
    tokens: {
      steps: [{ state: 'counted', billed: true, kinds: { cacheRead: { reported: 'all', n: 61_204 }, cacheWrite: { reported: 'all', n: 3_017 }, input: { reported: 'all', n: 402 }, output: { reported: 'all', n: 88 } } }, null],
      counting: 0,
      run: { state: 'counted', someStepsUnavailable: false, kinds: { cacheRead: { reported: 'all', n: 61_204 }, cacheWrite: { reported: 'all', n: 3_017 }, input: { reported: 'all', n: 402 }, output: { reported: 'all', n: 88 } } },
    },
  };

  it('hands the step names and counts to the panel, which shows them in its token table', () => {
    const panel = createLoopPanel(host);
    syncDockedPanel(loop(), 'plan', undefined, TOKENS, { render: (l, t, r, k) => panel.render(l, t, r, k), closePanel: vi.fn(), syncExpanded: vi.fn() });
    const text = (row: string): string => (tokenCellIn(host, row, 'cacheRead').textContent ?? '').replace(/\s+/g, ' ').trim();
    expect({ plan: text('plan'), build: text('build'), run: text(RUN_TOTAL_ROW) }).toEqual({ plan: '61,204 counting', build: '—', run: '61,204' });
  });

  it('counts alone are not content: with no loop and no refs it still closes and clears the panel', () => {
    const panel = createLoopPanel(host);
    panel.render(loop(), 'plan', undefined, TOKENS);
    const shownBefore = panelTokenTablesIn(host).length;
    const closePanel = vi.fn();
    syncDockedPanel(null, 'plan', undefined, TOKENS, { render: (l, t, r, k) => panel.render(l, t, r, k), closePanel, syncExpanded: vi.fn() });
    expect({ shownBefore, closed: closePanel.mock.calls.length, children: host.childElementCount }).toEqual({ shownBefore: 1, closed: 1, children: 0 });
  });
});
