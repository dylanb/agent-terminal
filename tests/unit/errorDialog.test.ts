// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createErrorDialog, type ErrorDialogOptions } from '../../src/renderer/src/errorDialog';
import { assertRendersFromHostDocument } from './relocatable';

// Slice B (§27.10) — the blocking error alert raised when an async bootstrap fails (a pickup that could
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

describe('error dialog (§27.10 bootstrap-failure alert)', () => {
  it('renders the reason message and a single Dismiss action', () => {
    createErrorDialog(host).render(opts({ message: 'could not resolve base branch' }));
    expect(host.textContent).toContain('could not resolve base branch');
    expect(dismissBtn()!.textContent).toBe('Dismiss');
  });

  it('exposes an alertdialog role with an accessible name describing the reason (WCAG 4.1.2)', () => {
    createErrorDialog(host).render(opts());
    const d = dialog()!;
    expect(d.getAttribute('role')).toBe('alertdialog');
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

  it('strips display-control characters from the repo-authored title and message (CWE-117, §B.13e)', () => {
    // Both fields are now first-time producers of repo-authored bytes: a cloned repo's in-repo v2 def can
    // reach `flow:onBootstrapError` (the origin refusal that stopped it is gone), and the step id lands in
    // the title. A U+202E (RTL override) must be neutralised at both sinks, exactly as the strip the
    // status-bar and loop-status paths share, so the operator's recovery surface cannot be spoofed.
    createErrorDialog(host).render({
      title: 'Bootstrap failed ‮ step',
      message: 'unsafe branch name ‮ rm -rf /',
    });
    const d = dialog()!;
    const titleEl = host.querySelector(`#${d.getAttribute('aria-labelledby')}`)!;
    const msgEl = host.querySelector(`#${d.getAttribute('aria-describedby')}`)!;
    expect(titleEl.textContent).not.toContain('‮');
    expect(msgEl.textContent).not.toContain('‮');
    // The visible text survives — the char becomes a space, nothing legitimate is dropped.
    expect(titleEl.textContent).toContain('Bootstrap failed');
    expect(msgEl.textContent).toContain('rm -rf /');
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

// WAI-ARIA APG: this dialog is pushed by main when a bootstrap or a loop turn fails — the user did not
// ask for it. `alertdialog` is the role for an urgent interrupting message, and it makes the screen
// reader announce the message along with the dialog rather than just the word "dialog".
describe('error dialog is an alert dialog (WAI-ARIA APG / SC 4.1.2)', () => {
  it('carries role=alertdialog with its message referenced as the description', () => {
    const dlg = createErrorDialog(host);
    dlg.render({ title: 'Loop error', message: 'the turn stalled' });

    const modal = host.querySelector('.flow-modal')!;
    expect(modal.getAttribute('role')).toBe('alertdialog');
    const describedBy = modal.getAttribute('aria-describedby')!;
    expect(host.querySelector(`#${describedBy}`)!.textContent).toBe('the turn stalled');
  });
});

// WCAG 2.1 SC 2.4.3 (Focus Order). The strip behind the dialog re-renders while it is open, so the opener
// can be detached by the time it closes. The composition root supplies where focus should land instead;
// without that wiring focus falls to <body>. This pins that the factory forwards the fallback.
describe('error dialog focus fallback (SC 2.4.3)', () => {
  it('invokes onFocusLost when the opener was detached while the dialog was open', () => {
    let landed = 0;
    const dlg = createErrorDialog(host, { onFocusLost: () => (landed += 1) });
    dlg.render(opts());
    opener.remove();
    dlg.render(null);
    expect(landed).toBe(1);
  });

  it('does not invoke onFocusLost when the opener survives', () => {
    let landed = 0;
    const dlg = createErrorDialog(host, { onFocusLost: () => (landed += 1) });
    dlg.render(opts());
    dlg.render(null);
    expect(landed).toBe(0);
  });
});
