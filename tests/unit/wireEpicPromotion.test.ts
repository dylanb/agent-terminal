import { describe, expect, it } from 'vitest';
import type { ConfirmDialogOptions } from '../../src/renderer/src/confirmDialog';
import { wireEpicPromotion, type EpicPromotionPreview } from '../../src/renderer/src/wireEpicPromotion';

// §28.7 — the epic-promotion confirm-first: the preview names every GitHub mutation the single confirm
// authorizes (each sub-ticket + the epic tracking edit + the epic PR close) as discrete items (WCAG 1.3.1),
// and confirm/cancel resolve against the exact repo + step the preview named (§6).

const PREVIEW: EpicPromotionPreview = {
  repoKey: '/repo/a',
  step: 'plan-bundle',
  epic: 176,
  pr: 77,
  subTickets: [{ index: 1, title: 'Wire the widget' }, { index: 2, title: 'Remove the widget' }],
};

function harness() {
  let deliver: ((preview: typeof PREVIEW) => void) | undefined;
  let opts: ConfirmDialogOptions | undefined;
  const resolved: Array<{ repoKey: string; step: string; confirm: boolean }> = [];
  wireEpicPromotion({
    onPreview: (cb) => {
      deliver = cb;
      return () => {};
    },
    confirm: (next) => {
      opts = next;
    },
    resolve: (repoKey, step, confirm) => void resolved.push({ repoKey, step, confirm }),
  });
  return { deliver: (p: typeof PREVIEW) => deliver!(p), opts: () => opts!, resolved };
}

describe('wireEpicPromotion (§28.7)', () => {
  it('confirms against the exact repo + step the preview named', () => {
    const h = harness();
    h.deliver(PREVIEW);
    h.opts().onConfirm();
    expect(h.resolved).toEqual([{ repoKey: '/repo/a', step: 'plan-bundle', confirm: true }]);
  });

  it('declines against that same identity', () => {
    const h = harness();
    h.deliver(PREVIEW);
    h.opts().onCancel?.();
    expect(h.resolved).toEqual([{ repoKey: '/repo/a', step: 'plan-bundle', confirm: false }]);
  });

  it('names each sub-ticket plus the epic edit and the PR close as its own item (WCAG 1.3.1)', () => {
    const h = harness();
    h.deliver(PREVIEW);
    expect(h.opts().resources).toEqual([
      'Create sub-ticket: Wire the widget',
      'Create sub-ticket: Remove the widget',
      'Add tracking checklist to epic #176',
      'Close epic planning PR #77',
    ]);
    expect(h.opts().role).toBe('alertdialog'); // app-raised, not operator-requested
  });

  it('omits the PR-close item when the epic has no planning PR', () => {
    const h = harness();
    h.deliver({ ...PREVIEW, pr: null });
    const named = (h.opts().resources ?? []).join('\n');
    expect(named).toContain('Add tracking checklist to epic #176');
    expect(named).not.toContain('planning PR');
  });

  it('phrases the title + message plural for a multi-sub-ticket epic', () => {
    const h = harness();
    h.deliver(PREVIEW);
    expect(h.opts().title).toBe('Create 2 sub-tickets?');
    expect(h.opts().message).toContain('2 sub-tickets');
    expect(h.opts().confirmLabel).toBe('Create sub-tickets');
  });

  it('phrases the title singular for a one-sub-ticket epic', () => {
    const h = harness();
    h.deliver({ ...PREVIEW, subTickets: [{ index: 1, title: 'Only slice' }] });
    expect(h.opts().title).toBe('Create 1 sub-ticket?');
    expect(h.opts().message).not.toContain('1 sub-tickets');
  });
});
