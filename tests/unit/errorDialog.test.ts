// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createErrorDialog, type ErrorDialogOptions } from '../../src/renderer/src/errorDialog';
import { assertRendersFromHostDocument } from './relocatable';

// Slice B (§26.9) — the blocking error alert raised when an async bootstrap fails (a pickup that could
// not run: dirty tree, unresolvable base, conflicting branch). A placement-agnostic blocking dialog
// (UI-STANDARDS §5): focus trap, role=dialog, focus move-in/restore. Unlike confirmDialog it carries no
// destructive action — a single Dismiss acknowledges it.

const opts = (over: Partial<ErrorDialogOptions> = {}): ErrorDialogOptions => ({
  title: 'Bootstrap failed',
  message: 'working tree is not clean',
  ...over,
});

let host: HTMLElement;
let opener: HTMLButtonElement;
beforeEach(() => {
  document.body.innerHTML = '<button id="opener">open</button><div id="error-host"></div>';
  host = document.getElementById('error-host')!;
  opener = document.getElementById('opener') as HTMLButtonElement;
  opener.focus();
});
afterEach(() => {
  document.body.innerHTML = '';
});

const dialog = () => host.querySelector<HTMLElement>('.flow-modal');
const dismissBtn = () => host.querySelector<HTMLButtonElement>('.flow-modal .dismiss');

describe('error dialog (§26.9 bootstrap-failure alert)', () => {
  it('renders the reason message and a single Dismiss action', () => {
    createErrorDialog(host).render(opts({ message: 'could not resolve base branch' }));
    expect(host.textContent).toContain('could not resolve base branch');
    expect(dismissBtn()!.textContent).toBe('Dismiss');
  });

  it('exposes a dialog role with an accessible name describing the reason (WCAG 4.1.2)', () => {
    createErrorDialog(host).render(opts());
    const d = dialog()!;
    expect(d.getAttribute('role')).toBe('dialog');
    expect(d.getAttribute('aria-modal')).toBe('true');
    const labelledBy = d.getAttribute('aria-labelledby');
    expect(host.querySelector(`#${labelledBy}`)?.textContent).toContain('Bootstrap failed');
    const describedBy = d.getAttribute('aria-describedby');
    expect(host.querySelector(`#${describedBy}`)?.textContent).toContain('working tree is not clean');
  });

  it('moves focus onto the dialog container (WCAG 2.4.3)', () => {
    createErrorDialog(host).render(opts());
    expect(document.activeElement).toBe(dialog());
  });

  it('Dismiss closes and restores focus to the opener', () => {
    createErrorDialog(host).render(opts());
    dismissBtn()!.click();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('Escape dismisses and restores focus to the opener (WCAG 2.4.3)', () => {
    createErrorDialog(host).render(opts());
    dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('render(null) closes an open dialog', () => {
    const d = createErrorDialog(host);
    d.render(opts());
    expect(dialog()).not.toBeNull();
    d.render(null);
    expect(dialog()).toBeNull();
  });

  it('dispose() clears the host subtree without restoring focus (unmount/relocation)', () => {
    const d = createErrorDialog(host);
    d.render(opts());
    d.dispose();
    expect(host.firstChild).toBeNull();
    expect(document.activeElement).not.toBe(opener);
  });

  it('builds from host.ownerDocument, not the global document (UI-STANDARDS §3.3 relocation)', async () => {
    await assertRendersFromHostDocument((h) => {
      createErrorDialog(h).render(opts());
    });
  });
});
