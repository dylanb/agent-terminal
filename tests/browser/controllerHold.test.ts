import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type { ControllerTerminal } from '../../src/shared/ipc';
import { cardHeaderIn, cardIn, heldCardsIn, listSequenceIn, selectedSortOptionsIn, sortOptionIn, windowHeaderIn } from '../helpers/controllerCards';
import { RECENTLY_USED_HEADING, SORT_SENTENCES, heading, orderDirectory as d, orderTerminal as t } from '../helpers/controllerCardOrderFixture';
import { mountControllerPanes } from '../helpers/controllerMount';
import { SORT_MODES } from '../helpers/controllerStatusFixture';
import '../helpers/rendererTokens';
import '../../src/renderer/src/styles.css';

const viewport = { width: window.innerWidth, height: window.innerHeight };
/** Wide and tall enough to show every card unscrolled, so restoring focus never scrolls another card under the pointer. */
beforeEach(() => page.viewport(1280, 1400));
afterEach(async () => {
  document.body.replaceChildren();
  await page.viewport(viewport.width, viewport.height);
});

const MINUTE = 60_000;
const settled = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

/** Registered in an order that is not their Attention order: Errors e, Idle & unassigned a then b, Working w. The pointer
 *  holds e, the first card, so a card after it that grows or shrinks never moves another card under the pointer. */
const TERMINALS = [t('a', 'idle'), t('w', 'working'), t('e', 'flow-error'), t('b', 'idle')];
const DIRECTORIES = TERMINALS.map(terminal => terminal.launchDirectory);
const ATTENTION = [heading('errors', 1), d('e'), heading('idle', 2), d('a'), d('b'), heading('working', 1), d('w')];
/** TERMINALS once card b has moved to Errors. */
const B_IN_ERRORS = [t('a', 'idle'), t('w', 'working'), t('e', 'flow-error'), t('b', 'flow-error')];
/** The list frozen as it was before card b moved to Errors, its counts updated. */
const FROZEN_B_IN_ERRORS = [heading('errors', 2), d('e'), heading('idle', 1), d('a'), d('b'), heading('working', 1), d('w')];
/** The list sorted once card b has moved to Errors. */
const SORTED_B_IN_ERRORS = [heading('errors', 2), d('e'), d('b'), heading('idle', 1), d('a'), heading('working', 1), d('w')];

function mount(options: { windowFocused?: boolean } = {}) {
  const parent = document.body.appendChild(document.createElement('section'));
  parent.style.width = '900px';
  return mountControllerPanes({ terminals: TERMINALS, parent, ...options });
}
function card(host: HTMLElement, name: string): HTMLElement {
  const found = cardIn(host, d(name));
  if (!found) throw new Error(`no card for ${d(name)}`);
  return found;
}
function toggle(host: HTMLElement, name: string): HTMLElement {
  const found = cardHeaderIn(card(host, name), d(name));
  if (!found) throw new Error(`no header toggle for ${d(name)}`);
  return found;
}
/** Moves the pointer onto the window header, off every card. */
async function pointerAway(host: HTMLElement): Promise<void> {
  const header = windowHeaderIn(host);
  if (!header) throw new Error('no window header');
  await userEvent.hover(header);
  await settled();
}
/** Publishes `terminals` a minute after the last change, then lets the screen settle. */
async function publishLater(service: { publish(terminals: ControllerTerminal[]): void }, clock: { advance(ms: number): void }, terminals: ControllerTerminal[]) {
  clock.advance(MINUTE);
  service.publish(terminals);
  await settled();
}
const read = (host: HTMLElement) => ({ list: listSequenceIn(host, DIRECTORIES), held: heldCardsIn(host, DIRECTORIES) });

it('holds the card under the pointer, showing " · position held" on it alone, keeps the list frozen through a group change, and re-sorts once the pointer leaves', async () => {
  const { host, service, clock, dispose } = mount();
  try {
    await pointerAway(host);
    await userEvent.hover(card(host, 'e'));
    await settled();
    await publishLater(service, clock, B_IN_ERRORS);
    const frozen = read(host);
    await pointerAway(host);
    expect({ frozen, after: read(host) }).toEqual({
      frozen: { list: FROZEN_B_IN_ERRORS, held: [d('e')] },
      after: { list: SORTED_B_IN_ERRORS, held: [] },
    });
  } finally { dispose(); }
});

it('keeps a card held while the pointer stays over it, whether or not the controller window has focus', async () => {
  const { host, service, clock, windowFocus, dispose } = mount();
  try {
    await pointerAway(host);
    await userEvent.hover(card(host, 'e'));
    windowFocus.set(false);
    await settled();
    await publishLater(service, clock, B_IN_ERRORS);
    const unfocused = read(host);
    windowFocus.set(true);
    await settled();
    const focused = read(host);
    await pointerAway(host);
    expect({ unfocused, focused, after: read(host) }).toEqual({
      unfocused: { list: FROZEN_B_IN_ERRORS, held: [d('e')] },
      focused: { list: FROZEN_B_IN_ERRORS, held: [d('e')] },
      after: { list: SORTED_B_IN_ERRORS, held: [] },
    });
  } finally { dispose(); }
});

it('keeps the list frozen while one of two held cards is still held, and re-sorts when the last hold ends', async () => {
  const { host, service, clock, dispose } = mount();
  try {
    await pointerAway(host);
    toggle(host, 'w').focus();
    await userEvent.hover(card(host, 'e'));
    await settled();
    await publishLater(service, clock, B_IN_ERRORS);
    const bothHeld = read(host);
    await pointerAway(host);
    const focusHeld = read(host);
    (document.activeElement as HTMLElement | null)?.blur();
    await settled();
    expect({ bothHeld, focusHeld, after: read(host) }).toEqual({
      bothHeld: { list: FROZEN_B_IN_ERRORS, held: [d('w'), d('e')] },
      focusHeld: { list: FROZEN_B_IN_ERRORS, held: [d('w')] },
      after: { list: SORTED_B_IN_ERRORS, held: [] },
    });
  } finally { dispose(); }
});

it('keeps " · position held" on a card held by focus and on one held by the pointer through a snapshot and a time-in-state tick', async () => {
  const { host, service, clock, dispose } = mount();
  try {
    await pointerAway(host);
    toggle(host, 'w').focus();
    await userEvent.hover(card(host, 'e'));
    await settled();
    const before = heldCardsIn(host, DIRECTORIES);
    await publishLater(service, clock, TERMINALS.map(terminal => ({ ...terminal })));
    const afterSnapshot = heldCardsIn(host, DIRECTORIES);
    clock.advance(MINUTE);
    await settled();
    expect({ before, afterSnapshot, afterTick: heldCardsIn(host, DIRECTORIES) })
      .toEqual({ before: [d('w'), d('e')], afterSnapshot: [d('w'), d('e')], afterTick: [d('w'), d('e')] });
  } finally { dispose(); }
});

it('keeps keyboard focus on the same control of a card that moves when the pointer hold ends', async () => {
  const { host, service, clock, dispose } = mount({ windowFocused: false });
  try {
    await pointerAway(host);
    toggle(host, 'b').focus();
    await userEvent.hover(card(host, 'e'));
    await settled();
    await publishLater(service, clock, B_IN_ERRORS);
    const frozen = read(host);
    await pointerAway(host);
    expect({ frozen, after: read(host), focusOnB: document.activeElement === toggle(host, 'b') }).toEqual({
      frozen: { list: FROZEN_B_IN_ERRORS, held: [d('e')] },
      after: { list: SORTED_B_IN_ERRORS, held: [] },
      focusOnB: true,
    });
  } finally { dispose(); }
});

it('shows a sort-order change made while a card is held in the control and the sentence at once, and re-sorts the list to it once the hold ends', async () => {
  const { host, dispose } = mount();
  try {
    const attention = await vi.waitFor(() => {
      const option = sortOptionIn(host, 'Attention');
      if (!option) throw new Error('the Attention sort option is not shown yet');
      return option;
    });
    await pointerAway(host);
    await userEvent.hover(card(host, 'e'));
    attention.focus();
    await userEvent.keyboard('{ArrowRight}');
    await settled();
    const sentences = () => SORT_MODES.filter(mode => (host.textContent ?? '').includes(SORT_SENTENCES[mode]));
    const frozen = { selected: selectedSortOptionsIn(host), sentences: sentences(), ...read(host) };
    await pointerAway(host);
    expect({ frozen, after: read(host) }).toEqual({
      frozen: { selected: ['Recently used'], sentences: ['recently-used'], list: ATTENTION, held: [d('e')] },
      after: { list: [RECENTLY_USED_HEADING, d('e'), d('a'), d('b'), d('w')], held: [] },
    });
  } finally { dispose(); }
});

it('ends a pointer hold when the pointer leaves the controller without passing over anything else in it', async () => {
  const outside = document.body.appendChild(document.createElement('div'));
  outside.style.height = '40px';
  const { host, service, clock, dispose } = mount();
  try {
    await pointerAway(host);
    await userEvent.hover(card(host, 'e'));
    await settled();
    await publishLater(service, clock, B_IN_ERRORS);
    const frozen = read(host);
    await userEvent.hover(outside);
    await settled();
    expect({ frozen, after: read(host) }).toEqual({
      frozen: { list: FROZEN_B_IN_ERRORS, held: [d('e')] },
      after: { list: SORTED_B_IN_ERRORS, held: [] },
    });
  } finally { dispose(); }
});

it('re-sorts at once when the card held by the pointer is removed while it is the only hold', async () => {
  const { host, service, clock, dispose } = mount();
  try {
    await pointerAway(host);
    await userEvent.hover(card(host, 'e'));
    await settled();
    const before = read(host);
    await publishLater(service, clock, B_IN_ERRORS.filter(terminal => terminal.launchDirectory !== d('e')));
    expect({ before, after: listSequenceIn(host, DIRECTORIES) }).toEqual({
      before: { list: ATTENTION, held: [d('e')] },
      after: [heading('errors', 1), d('b'), heading('idle', 1), d('a'), heading('working', 1), d('w')],
    });
  } finally { dispose(); }
});
