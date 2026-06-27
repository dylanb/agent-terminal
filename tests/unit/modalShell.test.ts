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
