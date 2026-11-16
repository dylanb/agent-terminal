// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAdoptTicketChoice, type AdoptTicketChoice } from '../../src/renderer/src/adoptTicketChoice';
import { assertRendersFromHostDocument } from './relocatable';
import { accessibleName } from '../helpers/byRole';
import type { AdoptTicketAnswer, AdoptTicketOffer, ResolveAdoptTicketResult } from '../../src/shared/ipc';

// #304 AC 4 — a run adopting a pull request that closes more than one acceptable ticket asks the operator, in a
// blocking dialog (UI-STANDARDS §5), which ticket is the run's primary, and answers the offer exactly once.

const ORIGIN_TICKET = { repo: 'owner/repo', number: 176 };
const FORK_TICKET = { repo: 'contributor/fork', number: 177 };
const OFFER: AdoptTicketOffer = { repoKey: '/repo', step: 'review', pr: 41, choiceId: 'offer-1', tickets: [ORIGIN_TICKET, FORK_TICKET] };

type Answer = (repoKey: string, step: string, choiceId: string, answer: AdoptTicketAnswer) => Promise<ResolveAdoptTicketResult>;

interface Mounted {
  host: HTMLElement;
  offer: (o?: AdoptTicketOffer) => void;
  answer: ReturnType<typeof vi.fn<Answer>>;
  choice: AdoptTicketChoice;
  focusLost: () => number;
}

function mount(host: HTMLElement): Mounted {
  let push: ((o: AdoptTicketOffer) => void) | undefined;
  let lost = 0;
  const answer = vi.fn<Answer>(async () => ({ ok: true }));
  const choice = createAdoptTicketChoice(host, {
    onOffer: (cb) => {
      push = cb;
      return () => {
        push = undefined;
      };
    },
    answer,
    onFocusLost: () => {
      lost += 1;
    },
  });
  return { host, offer: (o = OFFER) => push?.(o), answer, choice, focusLost: () => lost };
}

// One reading of the screen for every row: by role and accessible name.
const dialogOf = (root: ParentNode): HTMLElement | null => root.querySelector<HTMLElement>('[role="dialog"], [role="alertdialog"]');
const radiosOf = (root: ParentNode): HTMLInputElement[] =>
  [...root.querySelectorAll<HTMLInputElement>('input[type="radio"]:not([role]), [role="radio"]')];
const radioName = (radio: HTMLElement): string =>
  radio instanceof HTMLInputElement && radio.labels !== null && radio.labels.length > 0
    ? [...radio.labels].map((l) => l.textContent ?? '').join(' ').replace(/\s+/g, ' ').trim()
    : accessibleName(radio);
const radioFor = (root: ParentNode, ticket: { repo: string; number: number }): HTMLInputElement | undefined =>
  radiosOf(root).find((r) => radioName(r).includes(ticket.repo) && new RegExp(`(^|\\D)${ticket.number}(\\D|$)`).test(radioName(r)));
const isChecked = (radio: HTMLElement | undefined): boolean =>
  radio instanceof HTMLInputElement && radio.getAttribute('role') === null ? radio.checked : radio?.getAttribute('aria-checked') === 'true';
const buttonOf = (root: ParentNode, name: RegExp): HTMLButtonElement | undefined =>
  [...root.querySelectorAll<HTMLButtonElement>('button:not([role]), [role="button"]')].find((b) => name.test(accessibleName(b)));
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

let terminal: HTMLInputElement;
let placements: Array<{ placement: string; host: () => HTMLElement }>;
beforeEach(() => {
  document.body.innerHTML = '<input id="terminal"><main><div id="a"></div></main><aside><section><div id="b"></div></section></aside>';
  terminal = document.getElementById('terminal') as HTMLInputElement;
  placements = [
    { placement: 'the window body', host: () => document.getElementById('a')! },
    { placement: 'a nested side panel', host: () => document.getElementById('b')! },
  ];
});

// UI-STANDARDS §3.3: the same assertions in two placements.
describe.each([0, 1])('the ticket-choice dialog, placement %i (#304 AC 4)', (index) => {
  const mountHere = (): Mounted => mount(placements[index].host());

  it('opens on an offer as a modal dialog named by its rendered title, which names the pull request', () => {
    const m = mountHere();
    m.offer();
    const dialog = dialogOf(m.host);
    expect.soft(dialog?.getAttribute('aria-modal')).toBe('true');
    const titleId = dialog?.getAttribute('aria-labelledby') ?? '';
    expect.soft(titleId === '' ? '' : m.host.ownerDocument.getElementById(titleId)?.textContent ?? '').toMatch(/(^|\D)41(\D|$)/);
  });

  it('lists each offered ticket with its repository as one choice in one named group, with one already chosen', () => {
    const m = mountHere();
    m.offer();
    const dialog = dialogOf(m.host) ?? m.host;
    const all = [...dialog.querySelectorAll<HTMLElement>('[role="radiogroup"], fieldset')];
    const named = (g: HTMLElement): boolean => accessibleName(g) !== '' || (g.querySelector(':scope > legend')?.textContent ?? '') !== '';
    const groups = all.filter((g) => !all.some((o) => o !== g && o.contains(g)));
    expect.soft(groups.map((g) => named(g) || all.some((o) => g.contains(o) && named(o)))).toEqual([true]);
    expect.soft(radioFor(dialog, ORIGIN_TICKET), 'owner/repo#176').toBeDefined();
    expect.soft(radioFor(dialog, FORK_TICKET), 'contributor/fork#177').toBeDefined();
    expect.soft(radiosOf(dialog).filter(isChecked)).toHaveLength(1);
  });

  it('Confirm answers this offer once with the chosen ticket, and the dialog closes when main accepts it', async () => {
    const m = mountHere();
    m.offer();
    const dialog = dialogOf(m.host) ?? m.host;
    radioFor(dialog, FORK_TICKET)?.click();
    buttonOf(dialog, /^confirm/i)?.click();
    await flush();
    expect.soft(m.answer.mock.calls).toEqual([['/repo', 'review', 'offer-1', { kind: 'ticket', ticket: FORK_TICKET }]]);
    expect.soft(dialogOf(m.host)).toBeNull();
  });

  it('Confirm without a new choice sends the ticket shown as chosen', async () => {
    const m = mountHere();
    m.offer();
    const dialog = dialogOf(m.host) ?? m.host;
    const shown = [ORIGIN_TICKET, FORK_TICKET].filter((t) => isChecked(radioFor(dialog, t)));
    buttonOf(dialog, /^confirm/i)?.click();
    await flush();
    expect.soft(shown).toHaveLength(1);
    expect.soft(m.answer.mock.calls).toEqual([['/repo', 'review', 'offer-1', { kind: 'ticket', ticket: shown[0] }]]);
  });

  it('a refusal keeps the dialog open with the same choice, and announces the reason', async () => {
    const m = mountHere();
    m.answer.mockResolvedValueOnce({ ok: false, reason: 'pull request #41 no longer closes contributor/fork#177' });
    m.offer();
    const dialog = dialogOf(m.host) ?? m.host;
    radioFor(dialog, FORK_TICKET)?.click();
    buttonOf(dialog, /^confirm/i)?.click();
    await flush();
    expect.soft(dialogOf(m.host)).not.toBeNull();
    expect.soft(isChecked(radioFor(dialogOf(m.host) ?? m.host, FORK_TICKET))).toBe(true);
    expect.soft(dialogOf(m.host)?.querySelector('[role="alert"]')?.textContent ?? '').toContain('no longer closes contributor/fork#177');
    // The operator can still act on the same offer.
    buttonOf(dialogOf(m.host) ?? m.host, /^cancel/i)?.click();
    await flush();
    expect.soft(m.answer.mock.calls.at(-1)).toEqual(['/repo', 'review', 'offer-1', { kind: 'cancel' }]);
    expect.soft(m.answer).toHaveBeenCalledTimes(2);
    expect.soft(dialogOf(m.host)).toBeNull();
  });

  it('an accepted Confirm returns focus to where the operator was', async () => {
    const m = mountHere();
    terminal.focus();
    m.offer();
    const opened = dialogOf(m.host) !== null;
    buttonOf(dialogOf(m.host) ?? m.host, /^confirm/i)?.click();
    await flush();
    expect.soft(opened).toBe(true);
    expect.soft(document.activeElement).toBe(terminal);
  });

  it.each([
    ['Confirm', /^confirm/i],
    ['Cancel', /^cancel/i],
  ])('%s hands focus to the fallback when the element that had it is gone', async (_way, name) => {
    const m = mountHere();
    const opener = document.body.appendChild(document.createElement('button'));
    opener.focus();
    m.offer();
    const opened = dialogOf(m.host) !== null;
    opener.remove();
    buttonOf(dialogOf(m.host) ?? m.host, name)?.click();
    await flush();
    expect.soft(opened).toBe(true);
    expect.soft(m.focusLost()).toBe(1);
  });

  it.each([
    ['Cancel', (root: ParentNode) => buttonOf(dialogOf(root) ?? root, /^cancel/i)?.click()],
    ['Escape', (root: ParentNode) => dialogOf(root)?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))],
    ['the scrim', (root: ParentNode) => root.querySelector<HTMLElement>('.flow-scrim')?.click()],
  ])('%s answers this offer once with Cancel, closes the dialog and returns focus to where the operator was', async (_way, closeIt) => {
    const m = mountHere();
    terminal.focus();
    m.offer();
    const opened = dialogOf(m.host) !== null;
    closeIt(m.host);
    await flush();
    expect.soft(opened).toBe(true);
    expect.soft(m.answer.mock.calls).toEqual([['/repo', 'review', 'offer-1', { kind: 'cancel' }]]);
    expect.soft(dialogOf(m.host)).toBeNull();
    expect.soft(document.activeElement).toBe(terminal);
  });

  it('answers once while an answer is pending, however often Confirm, Cancel, Escape or the scrim are used', async () => {
    const m = mountHere();
    let settle!: (r: ResolveAdoptTicketResult) => void;
    m.answer.mockImplementationOnce(() => new Promise((res) => (settle = res)));
    m.offer();
    const dialog = dialogOf(m.host) ?? m.host;
    buttonOf(dialog, /^confirm/i)?.click();
    buttonOf(dialog, /^confirm/i)?.click();
    buttonOf(dialog, /^cancel/i)?.click();
    dialogOf(m.host)?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    m.host.querySelector<HTMLElement>('.flow-scrim')?.click();
    expect.soft(m.answer).toHaveBeenCalledTimes(1);
    expect.soft(dialogOf(m.host)).not.toBeNull();
    settle?.({ ok: true });
    await flush();
  });

  it('moves focus into the dialog on open, and Tab and Shift-Tab wrap inside it', () => {
    const m = mountHere();
    terminal.focus();
    m.offer();
    const dialog = dialogOf(m.host);
    expect.soft(dialog?.contains(document.activeElement) ?? false).toBe(true);
    const focusables = dialog === null ? [] : [...dialog.querySelectorAll<HTMLElement>('button, input')].filter((el) => !el.hasAttribute('disabled'));
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    last?.focus();
    dialog?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect.soft(dialog?.contains(document.activeElement) ?? false).toBe(true);
    expect.soft(focusables.length > 1 && document.activeElement !== last).toBe(true);
    first?.focus();
    dialog?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
    expect.soft(dialog?.contains(document.activeElement) ?? false).toBe(true);
    expect.soft(focusables.length > 1 && document.activeElement !== first).toBe(true);
  });

  it('dispose tears the open dialog down without answering the offer and without moving focus', () => {
    const m = mountHere();
    m.offer();
    const opened = dialogOf(m.host) !== null;
    const outside = document.body.appendChild(document.createElement('button'));
    outside.focus();
    m.choice.dispose();
    expect.soft(opened).toBe(true);
    expect.soft(dialogOf(m.host)).toBeNull();
    expect.soft(m.answer).not.toHaveBeenCalled();
    expect.soft(document.activeElement).toBe(outside);
  });
});

describe('the ticket-choice dialog, relocated (UI-STANDARDS §3.3)', () => {
  it("builds from its host's document", async () => {
    await assertRendersFromHostDocument((foreignHost) => {
      mount(foreignHost).offer();
    });
  });
});

describe('the ticket-choice dialog when main does not accept an answer (#304 AC 4)', () => {
  it('Cancel closes the dialog even when main refuses the answer, so the operator is never held inside it', async () => {
    const m = mount(placements[0].host());
    m.answer.mockResolvedValueOnce({ ok: false, reason: 'step review is not waiting for an answer to that ticket choice' });
    terminal.focus();
    m.offer();
    const opened = dialogOf(m.host) !== null;
    buttonOf(dialogOf(m.host) ?? m.host, /^cancel/i)?.click();
    await flush();
    expect.soft(opened).toBe(true);
    expect.soft(m.answer.mock.calls).toEqual([['/repo', 'review', 'offer-1', { kind: 'cancel' }]]);
    expect.soft(dialogOf(m.host)).toBeNull();
    expect.soft(document.activeElement).toBe(terminal);
  });

  it('a Confirm whose answer cannot reach main keeps the dialog open and announces why', async () => {
    const m = mount(placements[0].host());
    m.answer.mockRejectedValueOnce(new Error('the main process did not answer'));
    m.offer();
    buttonOf(dialogOf(m.host) ?? m.host, /^confirm/i)?.click();
    await flush();
    expect.soft(dialogOf(m.host)).not.toBeNull();
    expect.soft(dialogOf(m.host)?.querySelector('[role="alert"]')?.textContent ?? '').toContain('the main process did not answer');
  });
});

describe('the ticket-choice dialog with a ticket other than the first chosen (#304 AC 4, UI-STANDARDS §5)', () => {
  it('Shift-Tab from the chosen ticket keeps focus inside the dialog', () => {
    const m = mount(placements[0].host());
    terminal.focus();
    m.offer();
    const dialog = dialogOf(m.host);
    const fork = dialog === null ? undefined : radioFor(dialog, FORK_TICKET);
    fork?.click();
    fork?.focus();
    const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    dialog?.dispatchEvent(event);
    // A browser moves focus out of the dialog on a Shift-Tab the dialog does not take over.
    expect.soft(event.defaultPrevented).toBe(true);
    expect.soft(document.activeElement).toBe(buttonOf(dialog ?? m.host, /^confirm/i));
  });
});

describe('the ticket-choice dialog when a second offer arrives while one is open (#304 AC 4)', () => {
  it('answers the displaced offer with Cancel, so its held start is rolled back rather than left waiting', async () => {
    const m = mount(placements[0].host());
    m.offer();
    m.offer({ ...OFFER, repoKey: '/other-repo', choiceId: 'offer-2' });
    await flush();
    expect.soft(m.answer.mock.calls).toEqual([['/repo', 'review', 'offer-1', { kind: 'cancel' }]]);
    expect.soft(dialogOf(m.host)).not.toBeNull();
  });
});

describe('the ticket-choice dialog: Tab and a late answer (#304 AC 4, UI-STANDARDS §5)', () => {
  it('Tab from the last control wraps onto the chosen ticket, the radio group\'s one tab stop', () => {
    const m = mount(placements[0].host());
    m.offer();
    const dialog = dialogOf(m.host);
    const fork = dialog === null ? undefined : radioFor(dialog, FORK_TICKET);
    fork?.click();
    buttonOf(dialog ?? m.host, /^confirm/i)?.focus();
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    dialog?.dispatchEvent(event);
    expect.soft(event.defaultPrevented).toBe(true);
    expect.soft(document.activeElement).toBe(fork);
  });

  it('a Confirm that main accepts after a newer offer replaced it leaves the newer offer open and unanswered', async () => {
    const m = mount(placements[0].host());
    let settle!: (r: ResolveAdoptTicketResult) => void;
    m.answer.mockImplementationOnce(() => new Promise((res) => (settle = res)));
    m.offer();
    buttonOf(dialogOf(m.host) ?? m.host, /^confirm/i)?.click();
    m.offer({ ...OFFER, repoKey: '/other-repo', choiceId: 'offer-2', pr: 52 });
    settle({ ok: true });
    await flush();
    const dialog = dialogOf(m.host);
    expect.soft(dialog).not.toBeNull();
    const titleId = dialog?.getAttribute('aria-labelledby') ?? '';
    expect.soft(titleId === '' ? '' : m.host.ownerDocument.getElementById(titleId)?.textContent ?? '').toMatch(/(^|\D)52(\D|$)/);
    expect.soft(m.answer.mock.calls.filter((c) => c[2] === 'offer-2')).toEqual([]);
  });
});
