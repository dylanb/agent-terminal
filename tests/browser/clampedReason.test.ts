import { afterEach, describe, expect, it, vi } from 'vitest';
import '../helpers/rendererTokens';
import '../../src/renderer/src/styles.css';
import { createClampedReason } from '../../src/renderer/src/clampedReason';
import { cardIn, showFullReasonIn, showFullReasonsIn, showsFullReason } from '../helpers/controllerCards';
import { mountControllerPanes } from '../helpers/controllerMount';
import { statusTerminal } from '../helpers/controllerStatusFixture';

afterEach(() => document.body.replaceChildren());

const LINES = ['Reason line 1', 'Reason line 2', 'Reason line 3', 'Reason line 4', 'Reason line 5'];
const LONG = LINES.join('\n');

const clips = (style: CSSStyleDeclaration): boolean => style.overflowX !== 'visible' || style.overflowY !== 'visible';

/** Whether some occurrence of `text` in `root` is painted wholly inside every clipping ancestor up to `root`. */
function shown(root: HTMLElement, text: string): boolean {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const start = node.textContent?.indexOf(text) ?? -1;
    if (start < 0) continue;
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + text.length);
    const boxes = [...range.getClientRects()];
    let visible = boxes.length > 0;
    for (let parent: HTMLElement | null = node.parentElement; visible && parent; parent = parent === root ? null : parent.parentElement) {
      const style = getComputedStyle(parent);
      const clip = parent.getBoundingClientRect();
      visible = style.visibility === 'visible' && boxes.every(box => box.width > 0 && box.height > 0 && (!clips(style)
        || (box.left >= clip.left - 0.5 && box.right <= clip.right + 0.5 && box.top >= clip.top - 0.5 && box.bottom <= clip.bottom + 0.5)));
    }
    if (visible) return true;
  }
  return false;
}

const shownLines = (root: HTMLElement, lines: readonly string[] = LINES): number => lines.filter(line => shown(root, line)).length;

/** How many separate rows the painted reason lines sit on: five only when their line breaks are kept. */
function paintedRows(root: HTMLElement): number {
  const tops = new Set<number>();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    for (const line of LINES) {
      const start = node.textContent?.indexOf(line) ?? -1;
      if (start < 0 || !shown(root, line)) continue;
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + line.length);
      const first = range.getClientRects()[0];
      if (first) tops.add(Math.round(first.top));
    }
  }
  return tops.size;
}

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
    await expect.poll(() => ({ lines: shownLines(host), control: Boolean(showFullReasonIn(host)) })).toEqual({ lines: 3, control: true });
  });

  it('shows the whole reason with its line breaks when Show full reason is used, and shortens it when used again', async () => {
    const host = reasonHost('20rem');
    const toggles: boolean[] = [];
    createClampedReason(host, { text: LONG, full: false, onToggle: full => toggles.push(full) });
    (await settled(() => showFullReasonIn(host)))?.click();
    const opened = await settled(() => ({ lines: shownLines(host), rows: paintedRows(host) }), value => value.lines === 5 && value.rows === 5);
    showFullReasonIn(host)?.click();
    await expect.poll(() => ({ opened, closed: shownLines(host), toggles }))
      .toEqual({ opened: { lines: 5, rows: 5 }, closed: 3, toggles: [true, false] });
  });

  it('offers no Show full reason for a short reason', async () => {
    const host = reasonHost('20rem');
    createClampedReason(host, { text: LINES[0], full: false, onToggle() {} });
    for (let frame = 0; frame < 2; frame += 1) await new Promise(requestAnimationFrame);
    await expect.poll(() => ({ lines: shownLines(host), control: Boolean(showFullReasonIn(host)) })).toEqual({ lines: 1, control: false });
  });

  it('offers no Show full reason for a reason of exactly three lines', async () => {
    const host = reasonHost('20rem');
    createClampedReason(host, { text: LINES.slice(0, 3).join('\n'), full: false, onToggle() {} });
    for (let frame = 0; frame < 2; frame += 1) await new Promise(requestAnimationFrame);
    await expect.poll(() => ({ lines: shownLines(host, LINES.slice(0, 3)), control: Boolean(showFullReasonIn(host)) })).toEqual({ lines: 3, control: false });
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
    await expect.poll(() => ({ narrow, control: Boolean(showFullReasonIn(host)), shown: shown(host, text) }))
      .toEqual({ narrow: true, control: false, shown: true });
  });

  it('offers Show full reason for a reason delivered while hidden, once it is shown', async () => {
    const host = reasonHost('20rem');
    host.style.display = 'none';
    createClampedReason(host, { text: LONG, full: false, onToggle() {} });
    for (let frame = 0; frame < 2; frame += 1) await new Promise(requestAnimationFrame);
    host.style.display = '';
    await expect.poll(() => ({ lines: shownLines(host), control: Boolean(showFullReasonIn(host)) })).toEqual({ lines: 3, control: true });
  });
});

describe('a reason across live updates', () => {
  const blocked = (reason: string) => statusTerminal({ attention: { status: 'complete', reasons: [reason] } });
  const directory = blocked(LONG).launchDirectory;
  const card = (host: HTMLElement) => cardIn(host, directory);

  const control = (host: HTMLElement, directory_ = directory) => settled(() => { const c = cardIn(host, directory_); return c ? showFullReasonIn(c) : undefined; });

  it('keeps a reason shown in full when a live update keeps it', async () => {
    const { host, service, dispose } = mountControllerPanes({ terminals: [blocked(LONG)] });
    try {
      (await control(host))?.click();
      service.publish([blocked(LONG)]);
      for (let frame = 0; frame < 2; frame += 1) await new Promise(requestAnimationFrame);
      await expect.poll(() => {
        const after = card(host);
        return { lines: after ? shownLines(after) : 0, control: Boolean(after && showFullReasonIn(after)) };
      }).toEqual({ lines: 5, control: true });
    } finally { dispose(); }
  });

  it('keeps a reason shortened again when a live update keeps it', async () => {
    const { host, service, dispose } = mountControllerPanes({ terminals: [blocked(LONG)] });
    try {
      (await control(host))?.click();
      await settled(() => { const opened = card(host); return opened ? shownLines(opened) : 0; }, lines => lines === 5);
      (await control(host))?.click();
      service.publish([blocked(LONG)]);
      await expect.poll(() => {
        const after = card(host);
        return { lines: after ? shownLines(after) : 0, control: Boolean(after && showFullReasonIn(after)) };
      }).toEqual({ lines: 3, control: true });
    } finally { dispose(); }
  });

  it('limits each reason on its own, the human-needed ones and the error reason', async () => {
    const failure = LINES.map((_, index) => `Failure step ${index + 1}`);
    const both = statusTerminal({
      attention: { status: 'complete', reasons: ['A short reason', LONG] },
      error: { reason: failure.join('\n') },
    });
    const controls = showFullReasonsIn;
    const read = () => {
      const current = card(host);
      return current
        ? { short: shown(current, 'A short reason'), human: shownLines(current), error: shownLines(current, failure), controls: controls(current).length }
        : { short: false, human: 0, error: 0, controls: 0 };
    };
    const { host, dispose } = mountControllerPanes({ terminals: [both] });
    try {
      const limited = await settled(read, value => value.controls === 2);
      const current = card(host);
      if (current) controls(current)[0]?.click();
      const opened = await settled(read, value => value.human + value.error === 8);
      expect({ limited, opened: [opened.human, opened.error].sort() })
        .toEqual({ limited: { short: true, human: 3, error: 3, controls: 2 }, opened: [3, 5] });
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

  it("moves focus by #219's rule when a live update changes the reason", async () => {
    const { host, service, dispose } = mountControllerPanes({ terminals: [blocked(LONG)] });
    try {
      (await control(host))?.focus();
      service.publish([blocked('A different short reason')]);
      await expect.poll(() => {
        const focused = document.activeElement as HTMLElement;
        return { inside: host.contains(focused), usable: focused.matches('button:not(:disabled), [tabindex]') };
      }).toEqual({ inside: true, usable: true });
    } finally { dispose(); }
  });

  it('starts a reason shortened when it comes back after going away', async () => {
    const { host, service, dispose } = mountControllerPanes({ terminals: [blocked(LONG)] });
    try {
      (await control(host))?.click();
      service.publish([blocked('A different short reason')]);
      service.publish([blocked(LONG)]);
      await expect.poll(() => {
        const after = card(host);
        return { lines: after ? shownLines(after) : 0, control: Boolean(after && showFullReasonIn(after)) };
      }).toEqual({ lines: 3, control: true });
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
        return {
          changed: changed ? shownLines(changed) : 0,
          changedControl: Boolean(changed && showFullReasonIn(changed)),
          peer: peer ? shownLines(peer) : 0,
        };
      }).toEqual({ changed: 3, changedControl: true, peer: 3 });
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
