// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createModalShell, type ModalShellBuild } from '../../src/renderer/src/modalShell';

// Reusable modal shell (#26): the WCAG-2.4.3 Tab focus-trap is the shell's responsibility, so a
// caller can supply ANY focusable card body — the trap must wrap across the full focusable set, not
// just inputs and buttons. These drive the shell directly with a textarea + link to pin that.

let host: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = '<div id="modal-host"></div>';
  host = document.getElementById('modal-host')!;
});
afterEach(() => {
  document.body.innerHTML = '';
});

// A card whose focusables are, in DOM order: textarea (first), button (middle), link (last) — the
// trap's first/last must be the textarea and the link, neither of which the old selector matched.
const cardBuild = (): ModalShellBuild => ({ doc }) => {
  const card = doc.createElement('div');
  const ta = doc.createElement('textarea');
  ta.className = 'first';
  const mid = doc.createElement('button');
  mid.className = 'mid';
  mid.textContent = 'mid';
  const link = doc.createElement('a');
  link.className = 'last';
  link.setAttribute('href', '#');
  link.textContent = 'last';
  card.append(ta, mid, link);
  return { card, initialFocus: null };
};

const modal = () => host.querySelector<HTMLElement>('.flow-modal')!;
const first = () => host.querySelector<HTMLTextAreaElement>('.first')!;
const last = () => host.querySelector<HTMLAnchorElement>('.last')!;

describe('modal shell focus trap honors all focusable elements', () => {
  it('Tab on the last focusable (a link) wraps to the first (a textarea)', () => {
    createModalShell(host, 'm').render(cardBuild());
    last().focus();
    last().dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(first());
  });

  it('Shift+Tab on the first focusable (a textarea) wraps to the last (a link)', () => {
    createModalShell(host, 'm').render(cardBuild());
    first().focus();
    first().dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(last());
  });

  it('Shift+Tab from the dialog container wraps to the last focusable (a link)', () => {
    createModalShell(host, 'm').render(cardBuild());
    expect(document.activeElement).toBe(modal());
    modal().dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(last());
  });
});

// §18.3 — an optional onDismiss lets a caller (confirmDialog) distinguish a user DISMISS (Escape / scrim /
// the build's close) from its own programmatic teardown (render(null) / dispose), so a dialog that must
// report cancellation to main can. onDismiss fires exactly on a user-driven close of an open dialog.
describe('modal shell onDismiss (user-dismiss signal)', () => {
  const scrim = () => host.querySelector<HTMLElement>('.flow-scrim')!;

  it('fires onDismiss when the open dialog is dismissed via Escape', () => {
    let closes = 0;
    createModalShell(host, 'm', () => void closes++).render(cardBuild());
    modal().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(closes).toBe(1);
  });

  it('fires onDismiss when the scrim is clicked', () => {
    let closes = 0;
    createModalShell(host, 'm', () => void closes++).render(cardBuild());
    scrim().click();
    expect(closes).toBe(1);
  });

  it('does NOT fire onDismiss on programmatic render(null) or dispose (caller teardown, not a dismiss)', () => {
    let closes = 0;
    const shell = createModalShell(host, 'm', () => void closes++);
    shell.render(cardBuild());
    shell.render(null);
    expect(closes).toBe(0);
    shell.render(cardBuild());
    shell.dispose();
    expect(closes).toBe(0);
  });

  it('does not fire onDismiss when nothing is open', () => {
    let closes = 0;
    const shell = createModalShell(host, 'm', () => void closes++);
    shell.render(null); // never opened
    expect(closes).toBe(0);
  });
});

// WCAG 2.1 SC 2.4.3 (Focus Order). The opener is captured at open time, but the surfaces behind a dialog
// re-render (the flow strip rebuilds on a loop-activity phrase change), so the captured element can be
// detached by the time the dialog closes. `focus()` on a detached node is a silent no-op that drops focus
// to <body> — the keyboard user is returned to the top of the document.
describe('modal shell focus restoration (SC 2.4.3)', () => {
  it('restores focus to the opener when it is still in the document', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const shell = createModalShell(host, 'x');

    shell.render(cardBuild());
    shell.render(null);

    expect(document.activeElement).toBe(opener);
  });

  it('reports the focus loss when the opener was detached while the dialog was open', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    let lost = 0;
    const shell = createModalShell(host, 'x', undefined, { onFocusLost: () => (lost += 1) });

    shell.render(cardBuild());
    opener.remove(); // the surface behind the dialog re-rendered
    shell.render(null);

    expect(lost).toBe(1);
  });

  it('does not report a focus loss when the opener survives', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    let lost = 0;
    const shell = createModalShell(host, 'x', undefined, { onFocusLost: () => (lost += 1) });

    shell.render(cardBuild());
    shell.render(null);

    expect(lost).toBe(0);
  });
});

// WAI-ARIA APG: `alertdialog` is the role for a dialog whose content is an urgent message that interrupts
// the user — which is exactly a loop/bootstrap failure the user never asked for. `dialog` announces only
// "dialog"; `alertdialog` announces the message with it.
describe('modal shell dialog role (WAI-ARIA APG / SC 4.1.2)', () => {
  it('is role=dialog by default', () => {
    const shell = createModalShell(host, 'x');
    shell.render(cardBuild());
    expect(modal().getAttribute('role')).toBe('dialog');
  });

  it('carries role=alertdialog when the caller declares the dialog an alert', () => {
    const shell = createModalShell(host, 'x', undefined, { role: 'alertdialog' });
    shell.render(cardBuild());
    expect(modal().getAttribute('role')).toBe('alertdialog');
    expect(modal().getAttribute('aria-modal')).toBe('true');
  });
});

// `close` is the USER-dismiss path; a caller's own affirmative action (Confirm / Install) is NOT a dismissal
// and must not fire `onDismiss`, or the organism retracts an operation it is actually about to run — the
// success path then announces "cancelled" into its own live region (WCAG 4.1.3). Every consumer needs this,
// so the shell owns it: two hand-rolled `confirmed` flags are two chances to get it wrong.
describe('accept vs dismiss (the onDismiss contract)', () => {
  it('fires onDismiss when the build dismisses via close()', () => {
    let closed = 0;
    const shell = createModalShell(host, 'x', () => closed++);
    shell.render(({ doc, close }) => {
      const card = doc.createElement('div');
      const b = doc.createElement('button');
      b.id = 'dismiss';
      b.addEventListener('click', close);
      card.append(b);
      return { card, initialFocus: null };
    });
    host.querySelector<HTMLButtonElement>('#dismiss')!.click();
    expect(closed).toBe(1);
    expect(host.firstChild).toBeNull();
  });

  it('closes WITHOUT firing onDismiss when the build accepts via confirm()', () => {
    let closed = 0;
    const shell = createModalShell(host, 'x', () => closed++);
    shell.render(({ doc, confirm }) => {
      const card = doc.createElement('div');
      const b = doc.createElement('button');
      b.id = 'accept';
      b.addEventListener('click', confirm);
      card.append(b);
      return { card, initialFocus: null };
    });
    host.querySelector<HTMLButtonElement>('#accept')!.click();
    expect(closed).toBe(0);
    expect(host.firstChild).toBeNull();
  });
});

describe('modal shell while the dialog is answering a press', () => {
  const scrim = () => host.querySelector<HTMLElement>('.flow-scrim')!;

  it('Escape and the scrim leave the dialog open until the press is answered, then dismiss it', async () => {
    let answer!: () => void;
    let closes = 0;
    createModalShell(host, 'm', () => void closes++).render(({ doc, presses }) => {
      const card = doc.createElement('div');
      const submit = doc.createElement('button');
      submit.textContent = 'Submit';
      presses.bind(submit, () => new Promise<void>((r) => (answer = r)));
      card.append(submit);
      return { card, initialFocus: submit };
    });
    [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Submit'))!.click();

    modal().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    scrim().click();
    expect({ open: host.querySelector('[role="dialog"]') !== null, closes }).toEqual({ open: true, closes: 0 });

    answer();
    await new Promise((r) => setTimeout(r, 0));
    modal().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect({ open: host.querySelector('[role="dialog"]') !== null, closes }).toEqual({ open: false, closes: 1 });
  });
});
