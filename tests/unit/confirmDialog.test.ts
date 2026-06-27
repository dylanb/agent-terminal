// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfirmDialog, type ConfirmDialogOptions } from '../../src/renderer/src/confirmDialog';
import { assertRendersFromHostDocument } from './relocatable';

// Destructive confirmation dialog (#26 AC3/AC4/AC13) — a placement-agnostic blocking dialog
// (UI-STANDARDS §5, NOT the §4 Alert live-region pattern): focus trap, role=alertdialog (the
// WAI-ARIA APG role for a consequential confirmation), focus move-in/restore. The opener decides
// WHEN to open/close it (render(opts|null)).

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

  it('exposes an alertdialog role with an accessible name (AC13d / WCAG 4.1.2; WAI-ARIA APG alertdialog)', () => {
    createConfirmDialog(host).render(opts());
    const d = dialog()!;
    expect(d.getAttribute('role')).toBe('alertdialog');
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

  it('builds from host.ownerDocument, not the global document (UI-STANDARDS §3.3 relocation)', async () => {
    await assertRendersFromHostDocument((h) => {
      createConfirmDialog(h).render(opts());
    });
  });
});
