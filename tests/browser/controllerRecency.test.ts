import { afterEach, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import type { ControllerTerminal } from '../../src/shared/ipc';
import {
  bodyDirectoryIn, cardHeaderIn, cardIn, listSequenceIn, selectedSortOptionsIn, showFullReasonIn, showsFullReason, sortOptionIn, windowHeaderIn,
} from '../helpers/controllerCards';
import { RECENTLY_USED_HEADING, orderDirectory as d, orderTerminal as t } from '../helpers/controllerCardOrderFixture';
import { mountControllerPanes } from '../helpers/controllerMount';
import '../helpers/rendererTokens';
import '../../src/renderer/src/styles.css';

afterEach(() => document.body.replaceChildren());

const LONG_REASON = Array.from({ length: 40 }, (_, index) => `Review step ${index + 1} of the plan before it runs.`).join(' ');
const settled = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

/** A Needs a human card whose reason is long enough to be cut short, so it offers Show full reason. */
function longReason(name: string): ControllerTerminal {
  const terminal = t(name, 'needs-human');
  return { ...terminal, work: { ...terminal.work!, attention: { status: 'needs a human', reasons: [LONG_REASON] } } };
}

/** Registered in an order that is not their Attention order: Errors e1, Needs a human h1 then h2, Idle i1 then i2, Working w1. */
const TERMINALS = [t('i1', 'idle'), longReason('h1'), t('w1', 'working'), t('e1', 'flow-error'), t('i2', 'idle'), longReason('h2')];
const DIRECTORIES = TERMINALS.map(terminal => terminal.launchDirectory);
const ATTENTION_CARDS = [d('e1'), d('h1'), d('h2'), d('i1'), d('i2'), d('w1')];
/** The Recently used list once the `used` directories had a recency interaction, most recent first. */
const recentlyUsed = (...used: string[]): string[] => [RECENTLY_USED_HEADING, ...used, ...ATTENTION_CARDS.filter(card => !used.includes(card))];

async function inRecentlyUsed() {
  const parent = document.body.appendChild(document.createElement('section'));
  parent.style.width = '900px';
  const mounted = mountControllerPanes({ terminals: TERMINALS, parent });
  const option = await vi.waitFor(() => {
    const found = sortOptionIn(mounted.host, 'Recently used');
    if (!found) throw new Error('the Recently used sort option is not shown yet');
    return found;
  });
  await userEvent.click(option);
  await vi.waitFor(() => expect(selectedSortOptionsIn(mounted.host)).toEqual(['Recently used']));
  await settled();
  return mounted;
}

function card(host: HTMLElement, name: string): HTMLElement {
  const found = cardIn(host, d(name));
  if (!found) throw new Error(`no card for ${d(name)}`);
  return found;
}

/** Moves the pointer to the window header and focus out of the cards, so no card is held when the order is read. */
async function away(host: HTMLElement): Promise<void> {
  const header = windowHeaderIn(host);
  if (header) await userEvent.hover(header);
  (document.activeElement as HTMLElement | null)?.blur();
  await settled();
}

/** The list once it reads `expected`, or as it reads when it does not settle there. */
async function listSettled(host: HTMLElement, expected: readonly string[]): Promise<string[]> {
  await vi.waitFor(() => expect(listSequenceIn(host, DIRECTORIES)).toEqual(expected)).catch(() => undefined);
  return listSequenceIn(host, DIRECTORIES);
}

it('puts a card first in Recently used order once the operator shows its full reason', async () => {
  const { host, dispose } = await inRecentlyUsed();
  try {
    const control = showFullReasonIn(card(host, 'h2'));
    if (!control) throw new Error('h2 offers no Show full reason');
    await userEvent.click(control);
    const shownInFull = showsFullReason(showFullReasonIn(card(host, 'h2')));
    await away(host);
    expect.soft(shownInFull, 'the reason is shown in full').toBe(true);
    expect(await listSettled(host, recentlyUsed(d('h2')))).toEqual(recentlyUsed(d('h2')));
  } finally { dispose(); }
});

it('puts a card first in Recently used order once the operator collapses its full reason again', async () => {
  const { host, dispose } = await inRecentlyUsed();
  try {
    await userEvent.click(showFullReasonIn(card(host, 'h2'))!);
    await away(host);
    await userEvent.click(cardHeaderIn(card(host, 'i2'), d('i2'))!);
    await away(host);
    await listSettled(host, recentlyUsed(d('i2'), d('h2')));
    const control = showFullReasonIn(card(host, 'h2'));
    if (!control) throw new Error('h2 offers no Show full reason');
    await userEvent.click(control);
    const shownInFull = showsFullReason(showFullReasonIn(card(host, 'h2')));
    await away(host);
    expect.soft(shownInFull, 'the reason is cut short again').toBe(false);
    expect(await listSettled(host, recentlyUsed(d('h2'), d('i2')))).toEqual(recentlyUsed(d('h2'), d('i2')));
  } finally { dispose(); }
});

it('puts a card first once its header toggle is pressed from the keyboard', async () => {
  const { host, dispose } = await inRecentlyUsed();
  try {
    cardHeaderIn(card(host, 'i2'), d('i2'))!.focus();
    await userEvent.keyboard('{Enter}');
    await away(host);
    expect(await listSettled(host, recentlyUsed(d('i2')))).toEqual(recentlyUsed(d('i2')));
  } finally { dispose(); }
});

it('leaves recency unchanged when the operator hovers or focuses a card, or clicks its text outside its controls', async () => {
  const { host, dispose } = await inRecentlyUsed();
  try {
    await userEvent.click(cardHeaderIn(card(host, 'i2'), d('i2'))!);
    await away(host);
    const used = await listSettled(host, recentlyUsed(d('i2')));
    await userEvent.hover(card(host, 'w1'));
    await away(host);
    cardHeaderIn(card(host, 'w1'), d('w1'))!.focus();
    await away(host);
    await userEvent.hover(card(host, 'i1'));
    cardHeaderIn(card(host, 'i1'), d('i1'))!.focus();
    await away(host);
    await userEvent.click(bodyDirectoryIn(card(host, 'h1'), d('h1'))!);
    await away(host);
    const after = await listSettled(host, recentlyUsed(d('i2')));
    expect({ used, after }).toEqual({ used: recentlyUsed(d('i2')), after: recentlyUsed(d('i2')) });
  } finally { dispose(); }
});
