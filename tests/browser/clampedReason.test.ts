import { afterEach, describe, expect, it, vi } from 'vitest';
import '../../src/renderer/src/tokens.css';
import '../../src/renderer/src/styles.css';
import { createClampedReason } from '../../src/renderer/src/clampedReason';
import { cardHeaderIn, cardIn, showFullReasonIn, showFullReasonsIn, showsFullReason, statusRowIn } from '../helpers/controllerCards';
import { mountControllerPanes } from '../helpers/controllerMount';
import { statusTerminal } from '../helpers/controllerStatusFixture';

afterEach(() => document.body.replaceChildren());

const LINES = ['Reason line 1', 'Reason line 2', 'Reason line 3', 'Reason line 4', 'Reason line 5'];
const LONG = LINES.join('\n');

/** Whether the reason's Show full reason control reports it shown in full; undefined when no control is offered. */
const fullIn = (root: HTMLElement | undefined): boolean | undefined => {
  const control = root ? showFullReasonIn(root) : undefined;
  return control ? showsFullReason(control) : undefined;
};

/** `read()` once it satisfies `done`, waiting for the reason's painted measurement; its last value if it never does. */
const settled = <T>(read: () => T, done: (value: T) => boolean = Boolean): Promise<T> =>
  vi.waitFor(() => { const value = read(); if (!done(value)) throw new Error('not settled'); return value; }).catch(() => read());

function reasonHost(width: string) {
  const host = document.createElement('div');
  host.style.width = width;
  document.body.append(host);
  return host;
}

describe('a reason limited to three painted lines', () => {
  it('shows the first three lines of a longer reason, with Show full reason', async () => {
    const host = reasonHost('20rem');
    createClampedReason(host, { text: LONG, full: false, onToggle() {} });
    await expect.poll(() => fullIn(host)).toBe(false);
  });

  it('shows the whole reason with its line breaks when Show full reason is used, and shortens it when used again', async () => {
    const host = reasonHost('20rem');
    const toggles: boolean[] = [];
    createClampedReason(host, { text: LONG, full: false, onToggle: full => toggles.push(full) });
    (await settled(() => showFullReasonIn(host)))?.click();
    const opened = fullIn(host);
    showFullReasonIn(host)?.click();
    await expect.poll(() => ({ opened, closed: fullIn(host), toggles }))
      .toEqual({ opened: true, closed: false, toggles: [true, false] });
  });

  it('offers no Show full reason for a short reason', async () => {
    const host = reasonHost('20rem');
    createClampedReason(host, { text: LINES[0], full: false, onToggle() {} });
    for (let frame = 0; frame < 2; frame += 1) await new Promise(requestAnimationFrame);
    await expect.poll(() => Boolean(showFullReasonIn(host))).toBe(false);
  });

  it('offers no Show full reason for a reason of exactly three lines', async () => {
    const host = reasonHost('20rem');
    createClampedReason(host, { text: LINES.slice(0, 3).join('\n'), full: false, onToggle() {} });
    for (let frame = 0; frame < 2; frame += 1) await new Promise(requestAnimationFrame);
    await expect.poll(() => Boolean(showFullReasonIn(host))).toBe(false);
  });

  it('removes Show full reason once the card is wide enough for the reason', async () => {
    const text = 'A reason on one long line with no breaks in it at all '.repeat(3).trim();
    const host = reasonHost('auto');
    const probe = document.createElement('span');
    probe.style.whiteSpace = 'nowrap';
    probe.textContent = text;
    host.append(probe);
    const unwrapped = probe.getBoundingClientRect().width;
    probe.remove();
    host.style.width = `${unwrapped / 6}px`;
    createClampedReason(host, { text, full: false, onToggle() {} });
    const narrow = Boolean(await settled(() => showFullReasonIn(host)));
    host.style.width = `${unwrapped * 2}px`;
    await expect.poll(() => ({ narrow, control: Boolean(showFullReasonIn(host)) }))
      .toEqual({ narrow: true, control: false });
  });

  it('offers Show full reason for a reason delivered while hidden, once it is shown', async () => {
    const host = reasonHost('20rem');
    host.style.display = 'none';
    createClampedReason(host, { text: LONG, full: false, onToggle() {} });
    for (let frame = 0; frame < 2; frame += 1) await new Promise(requestAnimationFrame);
    host.style.display = '';
    await expect.poll(() => fullIn(host)).toBe(false);
  });
});

describe('a reason across live updates', () => {
  const blocked = (reason: string) => statusTerminal({ attention: { status: 'complete', reasons: [reason] }, activity: 'quiet' });
  const directory = blocked(LONG).launchDirectory;
  const card = (host: HTMLElement) => cardIn(host, directory);

  /** Lets the browser draw the card, then whether it is collapsed with its body not drawn. */
  async function drawnCollapsed(host: HTMLElement): Promise<boolean> {
    for (let frame = 0; frame < 2; frame += 1) await new Promise(requestAnimationFrame);
    const current = card(host);
    return Boolean(current) && cardHeaderIn(current!, directory)?.getAttribute('aria-expanded') === 'false'
      && statusRowIn(current!)?.checkVisibility({ visibilityProperty: true }) === false;
  }

  const control = (host: HTMLElement, directory_ = directory) => settled(() => { const c = cardIn(host, directory_); return c ? showFullReasonIn(c) : undefined; });

  it('keeps a reason shown in full when a live update keeps it', async () => {
    const { host, service, dispose } = mountControllerPanes({ terminals: [blocked(LONG)] });
    try {
      (await control(host))?.click();
      service.publish([blocked(LONG)]);
      for (let frame = 0; frame < 2; frame += 1) await new Promise(requestAnimationFrame);
      await expect.poll(() => {
        return fullIn(card(host));
      }).toBe(true);
    } finally { dispose(); }
  });

  it('keeps a reason shown in full after its card collapses and expands by its header', async () => {
    const { host, dispose } = mountControllerPanes({ terminals: [blocked(LONG)] });
    const header = () => { const current = card(host); return current ? cardHeaderIn(current, directory) : undefined; };
    try {
      (await control(host))?.click();
      await settled(() => fullIn(card(host)), full => full === true);
      header()?.click();
      const collapsed = await drawnCollapsed(host);
      header()?.click();
      await expect.poll(() => {
        return { collapsed, full: fullIn(card(host)) };
      }).toEqual({ collapsed: true, full: true });
    } finally { dispose(); }
  });

  it('limits a reason that arrived while its card was collapsed to three lines with Show full reason once the card expands', async () => {
    const { host, service, dispose } = mountControllerPanes({ terminals: [blocked('A short reason')], oneColumn: true });
    const header = () => { const current = card(host); return current ? cardHeaderIn(current, directory) : undefined; };
    try {
      header()?.click();
      service.publish([blocked(LONG)]);
      const collapsed = await drawnCollapsed(host);
      header()?.click();
      await expect.poll(() => {
        return { collapsed, full: fullIn(card(host)) };
      }).toEqual({ collapsed: true, full: false });
    } finally { dispose(); }
  });

  it('keeps a reason shortened again when a live update keeps it', async () => {
    const { host, service, dispose } = mountControllerPanes({ terminals: [blocked(LONG)] });
    try {
      (await control(host))?.click();
      await settled(() => fullIn(card(host)), full => full === true);
      (await control(host))?.click();
      service.publish([blocked(LONG)]);
      await expect.poll(() => {
        return fullIn(card(host));
      }).toBe(false);
    } finally { dispose(); }
  });

  it('limits each reason on its own, the human-needed ones and the error reason', async () => {
    const failure = LINES.map((_, index) => `Failure step ${index + 1}`);
    const both = statusTerminal({
      attention: { status: 'complete', reasons: ['A short reason', LONG] },
      error: { reason: failure.join('\n') },
    });
    const read = () => {
      const current = card(host);
      return current ? showFullReasonsIn(current).map(control => showsFullReason(control)) : [];
    };
    const { host, dispose } = mountControllerPanes({ terminals: [both] });
    try {
      const limited = await settled(read, value => value.length === 2);
      const current = card(host);
      if (current) showFullReasonsIn(current)[0]?.click();
      const opened = await settled(read, value => value.includes(true));
      expect({ limited, opened: [...opened].sort() }).toEqual({ limited: [false, false], opened: [false, true] });
    } finally { dispose(); }
  });

  it('keeps focus on Show full reason when a live update keeps the reason', async () => {
    const { host, service, dispose } = mountControllerPanes({ terminals: [blocked(LONG)] });
    try {
      (await control(host))?.focus();
      service.publish([blocked(LONG)]);
      await expect.poll(() => {
        const after = card(host);
        const current = after ? showFullReasonIn(after) : undefined;
        return { control: Boolean(current), focused: current !== undefined && document.activeElement === current };
      }).toEqual({ control: true, focused: true });
    } finally { dispose(); }
  });

  it('keeps focus on the same reason\'s Show full reason when the card holds two', async () => {
    const failure = LINES.map((_, index) => `Failure step ${index + 1}`).join('\n');
    const both = statusTerminal({ attention: { status: 'complete', reasons: [LONG] }, error: { reason: failure } });
    const { host, service, dispose } = mountControllerPanes({ terminals: [both] });
    try {
      const before = await settled(() => { const current = card(host); return current ? showFullReasonsIn(current) : []; }, found => found.length === 2);
      before[1]?.focus();
      service.publish([both]);
      await expect.poll(() => {
        const after = card(host);
        const controls = after ? showFullReasonsIn(after) : [];
        return { controls: controls.length, focused: controls.findIndex(current => current === document.activeElement) };
      }).toEqual({ controls: 2, focused: 1 });
    } finally { dispose(); }
  });

  it("moves focus by #219's rule, to the card's header, when a live update changes the reason", async () => {
    const { host, service, dispose } = mountControllerPanes({ terminals: [blocked(LONG)] });
    try {
      (await control(host))?.focus();
      service.publish([blocked('A different short reason')]);
      await expect.poll(() => {
        const after = card(host);
        const header = after ? cardHeaderIn(after, directory) : undefined;
        return header !== undefined && document.activeElement === header;
      }).toBe(true);
    } finally { dispose(); }
  });

  it('starts a reason shortened when it comes back after going away', async () => {
    const { host, service, dispose } = mountControllerPanes({ terminals: [blocked(LONG)] });
    try {
      (await control(host))?.click();
      service.publish([blocked('A different short reason')]);
      service.publish([blocked(LONG)]);
      await expect.poll(() => {
        return fullIn(card(host));
      }).toBe(false);
    } finally { dispose(); }
  });

  it('starts a changed reason, and the same reason on another terminal, shortened', async () => {
    const other = { ...blocked(LONG), id: 'other', launchDirectory: '/other/worktree' };
    const { host, service, dispose } = mountControllerPanes({ terminals: [blocked(LONG), other] });
    try {
      (await control(host))?.click();
      service.publish([blocked(`${LONG}\nReason line 6`), other]);
      await expect.poll(() => {
        const changed = card(host);
        const peer = cardIn(host, other.launchDirectory);
        return { changed: fullIn(changed), peer: fullIn(peer) };
      }).toEqual({ changed: false, peer: false });
    } finally { dispose(); }
  });
});

it('reports whether the reason is shown in full as the control\'s expanded state', async () => {
  const host = reasonHost('20rem');
  createClampedReason(host, { text: LONG, full: false, onToggle() {} });
  const shownInFull = () => showsFullReason(showFullReasonIn(host));
  await settled(() => showFullReasonIn(host));
  const before = shownInFull();
  showFullReasonIn(host)?.click();
  const opened = shownInFull();
  showFullReasonIn(host)?.click();
  expect({ before, opened, closed: shownInFull() }).toEqual({ before: false, opened: true, closed: false });
});
