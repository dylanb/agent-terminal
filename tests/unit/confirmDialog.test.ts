// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfirmDialog, type ConfirmDialogOptions } from '../../src/renderer/src/confirmDialog';
import { assertRendersFromHostDocument } from './relocatable';

// Destructive confirmation dialog (#26 AC3/AC4/AC13) — a placement-agnostic blocking dialog
// (UI-STANDARDS §5, NOT the §4 Alert live-region pattern): focus trap, role=dialog, focus
// move-in/restore. The opener decides WHEN to open/close it (render(opts|null)).

const opts = (over: Partial<ConfirmDialogOptions> = {}): ConfirmDialogOptions => ({
  title: 'Terminate flow',
  message: 'This deletes 3 todos for this repository.',
  confirmLabel: 'Terminate',
  onConfirm: vi.fn(),
  ...over,
});

let host: HTMLElement;
let opener: HTMLButtonElement;
beforeEach(() => {
  document.body.innerHTML = '<button id="opener">open</button><div id="confirm-host"></div>';
  host = document.getElementById('confirm-host')!;
  opener = document.getElementById('opener') as HTMLButtonElement;
  opener.focus(); // the control that opened the dialog (focus restores here on close, WCAG 2.4.3)
});
afterEach(() => {
  document.body.innerHTML = '';
});

const dialog = () => host.querySelector<HTMLElement>('.flow-modal');
const confirmBtn = () => host.querySelector<HTMLButtonElement>('.flow-modal .confirm');
const cancelBtn = () => host.querySelector<HTMLButtonElement>('.flow-modal .cancel');

describe('confirm dialog (#26 AC3/AC4/AC13)', () => {
  it('renders the count message and a destructive confirm label (AC3)', () => {
    createConfirmDialog(host).render(opts({ message: 'This deletes 0 todos for this repository.' }));
    expect(host.textContent).toContain('0 todos');
    expect(confirmBtn()!.textContent).toBe('Terminate');
  });

  it('exposes a dialog role with an accessible name (AC13d / WCAG 4.1.2)', () => {
    createConfirmDialog(host).render(opts());
    const d = dialog()!;
    expect(d.getAttribute('role')).toBe('dialog');
    expect(d.getAttribute('aria-modal')).toBe('true');
    const labelledBy = d.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    expect(host.querySelector(`#${labelledBy}`)?.textContent).toContain('Terminate flow');
    const describedBy = d.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(host.querySelector(`#${describedBy}`)?.textContent).toContain('3 todos');
  });

  it('moves focus onto the dialog container with no action pre-focused (AC13b / WCAG 2.4.3)', () => {
    createConfirmDialog(host).render(opts());
    expect(document.activeElement).toBe(dialog());
    expect(document.activeElement).not.toBe(confirmBtn());
  });

  it('Confirm runs onConfirm once, then closes and restores focus to the opener', () => {
    const onConfirm = vi.fn();
    createConfirmDialog(host).render(opts({ onConfirm }));
    confirmBtn()!.click();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('Cancel makes no change (no onConfirm) and restores focus to the opener (AC4)', () => {
    const onConfirm = vi.fn();
    createConfirmDialog(host).render(opts({ onConfirm }));
    cancelBtn()!.click();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('Escape dismisses with no change and restores focus to the opener (AC13c / AC4)', () => {
    const onConfirm = vi.fn();
    createConfirmDialog(host).render(opts({ onConfirm }));
    dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('is keyboard-operable: Cancel and Confirm are focusable buttons (AC13a / WCAG 2.1.1)', () => {
    createConfirmDialog(host).render(opts());
    confirmBtn()!.focus();
    expect(document.activeElement).toBe(confirmBtn());
    cancelBtn()!.focus();
    expect(document.activeElement).toBe(cancelBtn());
  });

  it('traps Tab within the dialog (AC13a / WCAG 2.4.3): last wraps to first, first wraps to last', () => {
    createConfirmDialog(host).render(opts());
    const first = cancelBtn()!;
    const last = confirmBtn()!;
    last.focus();
    last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(first);
    first.focus();
    first.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(last);
  });

  it('Shift+Tab from the dialog container itself wraps to the last action (AC13b / WCAG 2.4.3)', () => {
    createConfirmDialog(host).render(opts());
    const d = dialog()!;
    expect(document.activeElement).toBe(d);
    d.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(confirmBtn());
  });

  it('dispose() clears the host subtree and does NOT restore focus to the opener (unmount/relocation)', () => {
    const d = createConfirmDialog(host);
    d.render(opts());
    expect(host.childElementCount).toBeGreaterThan(0);
    expect(document.activeElement).toBe(dialog());

    d.dispose();
    expect(host.firstChild).toBeNull();
    expect(document.activeElement).not.toBe(opener);
  });

  it('dispose() on an already-closed dialog is idempotent and does not throw', () => {
    const d = createConfirmDialog(host);
    expect(() => d.dispose()).not.toThrow();
    d.render(opts());
    d.render(null);
    expect(() => d.dispose()).not.toThrow();
    expect(host.firstChild).toBeNull();
  });

  it('render(null) closes an open dialog', () => {
    const d = createConfirmDialog(host);
    d.render(opts());
    expect(dialog()).not.toBeNull();
    d.render(null);
    expect(dialog()).toBeNull();
  });

  it('cancel() closes an open dialog through its semantic decline action', () => {
    const onCancel = vi.fn();
    const d = createConfirmDialog(host);
    d.render(opts({ onCancel }));

    d.cancel();

    expect(dialog()).toBeNull();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('builds from host.ownerDocument, not the global document (UI-STANDARDS §3.3 relocation)', async () => {
    await assertRendersFromHostDocument((h) => {
      createConfirmDialog(h).render(opts());
    });
  });

  // §18.3 — the wipe-and-retry confirmation must tell main to roll the flow back when the operator
  // declines, so an optional onCancel fires on every dismiss path EXCEPT confirm (which runs onConfirm).
  describe('onCancel (dismiss signal, §18.3)', () => {
    it('fires onCancel on the Cancel button, and does NOT run onConfirm', () => {
      const onConfirm = vi.fn();
      const onCancel = vi.fn();
      createConfirmDialog(host).render(opts({ onConfirm, onCancel }));
      cancelBtn()!.click();
      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(onConfirm).not.toHaveBeenCalled();
    });

    it('fires onCancel on Escape dismissal', () => {
      const onCancel = vi.fn();
      createConfirmDialog(host).render(opts({ onCancel }));
      dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it('does NOT fire onCancel when Confirm is clicked (confirm is not a cancel)', () => {
      const onConfirm = vi.fn();
      const onCancel = vi.fn();
      createConfirmDialog(host).render(opts({ onConfirm, onCancel }));
      confirmBtn()!.click();
      expect(onConfirm).toHaveBeenCalledTimes(1);
      expect(onCancel).not.toHaveBeenCalled();
    });

    // The Terminate confirm and the §18.3 bootstrap-conflict confirm share one dialog instance. If a new
    // dialog is rendered while an unanswered one is open, the displaced dialog's onCancel must still run —
    // otherwise a conflict confirm silently displaced by another dialog would leave main's pendingConflict
    // set and the flow un-rolled-back (the never-strand rule).
    it('fires the displaced dialog\'s onCancel when a new dialog replaces an open, unanswered one', () => {
      const d = createConfirmDialog(host);
      const onCancelA = vi.fn();
      const onCancelB = vi.fn();
      const onConfirmB = vi.fn();
      d.render(opts({ title: 'Dialog A', onCancel: onCancelA }));
      d.render(opts({ title: 'Dialog B', onCancel: onCancelB, onConfirm: onConfirmB }));
      expect(onCancelA).toHaveBeenCalledTimes(1); // A was declined by being replaced
      expect(onCancelB).not.toHaveBeenCalled();
      expect(onConfirmB).not.toHaveBeenCalled();
      expect(host.querySelector('.flow-modal')?.textContent).toContain('Dialog B'); // B is now shown
    });

    it('does NOT re-fire onCancel of a dialog already dismissed via Cancel when a new dialog opens', () => {
      const d = createConfirmDialog(host);
      const onCancelA = vi.fn();
      d.render(opts({ title: 'Dialog A', onCancel: onCancelA }));
      cancelBtn()!.click(); // A dismissed → onCancelA fires once, A closed
      expect(onCancelA).toHaveBeenCalledTimes(1);
      d.render(opts({ title: 'Dialog B' }));
      expect(onCancelA).toHaveBeenCalledTimes(1); // NOT re-fired by the later render
    });

    it('does NOT fire onCancel of a CONFIRMED dialog when a new dialog replaces it', () => {
      const d = createConfirmDialog(host);
      const onCancelA = vi.fn();
      d.render(opts({ title: 'Dialog A', onCancel: onCancelA, onConfirm: vi.fn() }));
      confirmBtn()!.click(); // A confirmed + closed
      d.render(opts({ title: 'Dialog B' }));
      expect(onCancelA).not.toHaveBeenCalled();
    });
  });
});

// WAI-ARIA APG names this exact case for `alertdialog`: a modal that interrupts the user's workflow with
// an action confirmation. UI-STANDARDS §5.2 draws the same boundary — errorDialog is system-raised and
// uses `alertdialog`; a user-initiated confirm stays `dialog`.
describe('createConfirmDialog — system-raised alerts', () => {
  it('carries role=alertdialog when the caller declares the confirmation an alert', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const dialog = createConfirmDialog(host);
    dialog.render({
      title: 'Bootstrap resources already exist',
      message: 'Wiping will delete or close exactly: origin branch topic.',
      confirmLabel: 'Wipe and retry',
      role: 'alertdialog',
      onConfirm: () => {},
    });

    expect(
      host.querySelector('.flow-modal')?.getAttribute('role'),
    ).toBe('alertdialog');
    dialog.dispose();
    host.remove();
  });

  // The resources are the whole content of an irreversible confirmation: a description that carries only
  // their COUNT tells a screen-reader user to answer a question a sighted user can read the answer to.
  it('names every resource it would destroy in the dialog accessible description (WCAG 1.3.1/4.1.2)', () => {
    createConfirmDialog(host).render(
      opts({
        title: 'Wipe existing resources?',
        message: 'This will destroy 2 resources. It cannot be undone.',
        resources: ['Delete local branch topic (abc1234)', 'Close pull request owner/repo#7'],
        confirmLabel: 'Wipe and retry',
        role: 'alertdialog',
      }),
    );
    // aria-describedby is an IDREF *list*; the description AT announces is every referenced node, in order.
    const description = dialog()!
      .getAttribute('aria-describedby')!
      .split(/\s+/)
      .map((id) => host.querySelector(`#${id}`)?.textContent ?? '')
      .join(' ');
    expect(description).toContain('Delete local branch topic (abc1234)');
    expect(description).toContain('Close pull request owner/repo#7');
  });

  // WCAG 1.3.1 — the set's count and each item's boundary must be programmatically determinable, not
  // recoverable only by reading commas out of one utterance.
  it('renders each resource as its own list item', () => {
    createConfirmDialog(host).render(
      opts({
        message: 'This will destroy 2 resources. It cannot be undone.',
        resources: ['Delete local branch topic (abc1234)', 'Close pull request owner/repo#7'],
      }),
    );
    expect(
      [...host.querySelectorAll('.flow-modal li')].map((li) => li.textContent),
    ).toEqual(['Delete local branch topic (abc1234)', 'Close pull request owner/repo#7']);
  });

  it('stays role=dialog for a confirmation the user asked for', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const dialog = createConfirmDialog(host);
    dialog.render({
      title: 'Terminate',
      message: 'Terminate the flow?',
      confirmLabel: 'Terminate',
      onConfirm: () => {},
    });

    expect(
      host.querySelector('.flow-modal')?.getAttribute('role'),
    ).toBe('dialog');
    dialog.dispose();
    host.remove();
  });
});
