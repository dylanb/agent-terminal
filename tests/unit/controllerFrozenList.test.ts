// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ControllerTerminal } from '../../src/shared/ipc';
import {
  cardHeaderIn, cardIn, dismissIn, headerActivationIn, headerLabels, headerStatusIn, heldCardsIn, isExpanded, listSequenceIn,
  selectedSortOptionsIn, sortOptionIn, unshownCounts, windowHeaderIn, type SortOption,
} from '../helpers/controllerCards';
import { RECENTLY_USED_HEADING, heading, orderDirectory as d, orderTerminal as t } from '../helpers/controllerCardOrderFixture';
import { mountControllerPanes } from '../helpers/controllerMount';
import type { SummaryLabel } from '../helpers/controllerStatusFixture';

afterEach(() => document.body.replaceChildren());

const MINUTE = 60_000;
const directoriesOf = (terminals: readonly ControllerTerminal[]): string[] => [...new Set(terminals.map(terminal => terminal.launchDirectory))];
const counted = (counts: Partial<Record<SummaryLabel, number>>) => (label: string): number => counts[label as SummaryLabel] ?? 0;
/** Lets a queued re-sort land before the screen is read. */
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/** Waits for the sort control to be shown and returns its option `name`. */
const sortOption = (host: HTMLElement, name: SortOption): Promise<HTMLElement> => vi.waitFor(() => {
  const option = sortOptionIn(host, name);
  if (!option) throw new Error(`the ${name} sort option is not shown yet`);
  return option;
});
const card = (host: HTMLElement, name: string): HTMLElement => {
  const found = cardIn(host, d(name));
  if (!found) throw new Error(`no card for ${d(name)}`);
  return found;
};
const toggle = (host: HTMLElement, name: string): HTMLElement => {
  const found = cardHeaderIn(card(host, name), d(name));
  if (!found) throw new Error(`no header toggle for ${d(name)}`);
  return found;
};
const headerOf = (host: HTMLElement, name: string): string => headerStatusIn(card(host, name), d(name));
/** Moves keyboard focus out of every card, which ends a hold by focus. */
const blur = (): void => (document.activeElement as HTMLElement | null)?.blur();

/** Every change made under the window's live regions, from the moment it is created. */
function regionChanges(host: HTMLElement): () => MutationRecord[] {
  const observer = new MutationObserver(() => {});
  for (const region of host.querySelectorAll('[role="status"], [role="alert"]')) {
    observer.observe(region, { childList: true, characterData: true, subtree: true, attributes: true });
  }
  return () => observer.takeRecords();
}

/** Cards in all four groups, registered in an order that is not their Attention order; the Idle & unassigned group holds two. */
const TERMINALS = [t('a', 'idle'), t('w', 'working'), t('e', 'flow-error'), t('b', 'idle'), t('h', 'needs-human')];
const DIRECTORIES = directoriesOf(TERMINALS);
const ATTENTION = [heading('errors', 1), d('e'), heading('need a human', 1), d('h'), heading('idle', 2), d('a'), d('b'), heading('working', 1), d('w')];
const RECENTLY_USED = [RECENTLY_USED_HEADING, d('e'), d('h'), d('a'), d('b'), d('w')];
/** TERMINALS once card a has moved to Errors. */
const A_IN_ERRORS = [t('a', 'flow-error'), ...TERMINALS.slice(1)];
const ATTENTION_A_IN_ERRORS = [heading('errors', 2), d('e'), d('a'), heading('need a human', 1), d('h'), heading('idle', 1), d('b'), heading('working', 1), d('w')];

async function inRecentlyUsed(terminals: ControllerTerminal[] = TERMINALS) {
  const mounted = mountControllerPanes({ terminals });
  (await sortOption(mounted.host, 'Recently used')).click();
  await vi.waitFor(() => expect(selectedSortOptionsIn(mounted.host)).toEqual(['Recently used']));
  return mounted;
}

describe('a card held by keyboard focus', () => {
  it.each([
    ['its header toggle', (host: HTMLElement) => toggle(host, 'h')],
    ['its Bring forward', (host: HTMLElement) => headerActivationIn(card(host, 'h'))],
  ])('shows " · position held" while focus is on %s, on that card alone, and not once focus leaves it', async (_, control) => {
    const { host, dispose } = mountControllerPanes({ terminals: TERMINALS });
    try {
      control(host)?.focus();
      await flush();
      const whileHeld = heldCardsIn(host, DIRECTORIES);
      blur();
      await flush();
      expect({ whileHeld, after: heldCardsIn(host, DIRECTORIES) }).toEqual({ whileHeld: [d('h')], after: [] });
    } finally { dispose(); }
  });

  it('moves nothing by starting the hold', async () => {
    const { host, dispose } = mountControllerPanes({ terminals: TERMINALS });
    try {
      toggle(host, 'h').focus();
      await flush();
      expect({ held: heldCardsIn(host, DIRECTORIES), list: listSequenceIn(host, DIRECTORIES) }).toEqual({ held: [d('h')], list: ATTENTION });
    } finally { dispose(); }
  });

  it('is not held while the controller window itself does not have focus', async () => {
    const { host, windowFocus, dispose } = mountControllerPanes({ terminals: TERMINALS });
    try {
      toggle(host, 'h').focus();
      await flush();
      const focusedWindow = heldCardsIn(host, DIRECTORIES);
      windowFocus.set(false);
      await flush();
      expect({ focusedWindow, unfocusedWindow: heldCardsIn(host, DIRECTORIES) }).toEqual({ focusedWindow: [d('h')], unfocusedWindow: [] });
    } finally { dispose(); }
  });

  it('announces nothing when a hold starts or ends', async () => {
    const { host, dispose } = mountControllerPanes({ terminals: TERMINALS });
    try {
      const changes = regionChanges(host);
      toggle(host, 'h').focus();
      await flush();
      const whileHeld = heldCardsIn(host, DIRECTORIES);
      blur();
      await flush();
      expect({ whileHeld, after: heldCardsIn(host, DIRECTORIES), regionChanges: changes() })
        .toEqual({ whileHeld: [d('h')], after: [], regionChanges: [] });
    } finally { dispose(); }
  });
});

describe('the frozen list', () => {
  it('keeps every card and heading in place through a group change, while the moved card\'s header status, time labels and every count still update', async () => {
    const { host, service, clock, dispose } = mountControllerPanes({ terminals: TERMINALS });
    try {
      toggle(host, 'h').focus();
      clock.advance(MINUTE);
      service.publish(A_IN_ERRORS);
      clock.advance(2 * MINUTE);
      await flush();
      expect({
        list: listSequenceIn(host, DIRECTORIES),
        a: headerOf(host, 'a'),
        e: headerOf(host, 'e'),
        unshownWindowCounts: unshownCounts(windowHeaderIn(host)?.textContent ?? '', headerLabels(counted({ errors: 2, 'need a human': 1, idle: 1, working: 1 }), 5, 5)),
      }).toEqual({
        list: [heading('errors', 2), d('e'), heading('need a human', 1), d('h'), heading('idle', 1), d('a'), d('b'), heading('working', 1), d('w')],
        a: expect.stringMatching(/Flow error · Idle · for 2m$/),
        e: expect.stringMatching(/Flow error · Idle · for 3m$/),
        unshownWindowCounts: [],
      });
    } finally { dispose(); }
  });

  it('keeps the heading of a group that loses all its cards, counted 0, and adds no heading for a group a card joins', async () => {
    const terminals = [t('e', 'flow-error'), t('a', 'idle'), t('w', 'working')];
    const { host, service, clock, dispose } = mountControllerPanes({ terminals });
    try {
      toggle(host, 'e').focus();
      clock.advance(MINUTE);
      service.publish([t('e', 'flow-error'), t('a', 'needs-human'), t('w', 'working')]);
      await flush();
      expect({ list: listSequenceIn(host, directoriesOf(terminals)), a: headerOf(host, 'a') }).toEqual({
        list: [heading('errors', 1), d('e'), heading('idle', 0), d('a'), heading('working', 1), d('w')],
        a: expect.stringMatching(/Needs a human · Idle · waiting under 1m$/),
      });
    } finally { dispose(); }
  });

  it('keeps cards in place when time-in-state order changes within a group, and re-sorts once the hold ends', async () => {
    const terminals = [t('x', 'disconnected'), t('y', 'idle'), t('i', 'working')];
    const directories = directoriesOf(terminals);
    const { host, service, clock, dispose } = mountControllerPanes({ terminals });
    try {
      clock.advance(MINUTE);
      service.publish([t('x', 'disconnected'), t('y', 'flow-error'), t('i', 'working')]);
      toggle(host, 'i').focus();
      clock.advance(MINUTE);
      service.publish([t('x', 'flow-error'), t('y', 'flow-error'), t('i', 'working')]);
      await flush();
      const frozen = listSequenceIn(host, directories);
      blur();
      await flush();
      expect({ frozen, after: listSequenceIn(host, directories) }).toEqual({
        frozen: [heading('errors', 2), d('x'), d('y'), heading('working', 1), d('i')],
        after: [heading('errors', 2), d('y'), d('x'), heading('working', 1), d('i')],
      });
    } finally { dispose(); }
  });

  it.each([
    ['Attention', 'attention', [heading('errors', 2), ...ATTENTION.slice(1), d('n')]],
    ['Recently used', 'recently-used', [...RECENTLY_USED, d('n')]],
  ] as const)('adds a card that arrives at the end of the list in %s order, with no heading of its own, counted under its group\'s heading', async (_, mode, expected) => {
    const { host, service, dispose } = mode === 'attention' ? mountControllerPanes({ terminals: TERMINALS }) : await inRecentlyUsed();
    try {
      toggle(host, 'h').focus();
      const arrived = [...TERMINALS, t('n', 'flow-error')];
      service.publish(arrived);
      await flush();
      expect(listSequenceIn(host, directoriesOf(arrived))).toEqual(expected);
    } finally { dispose(); }
  });

  it('drops a card that is removed, the cards after it moving up one place, and re-sorts nothing else', async () => {
    const { host, service, clock, dispose } = mountControllerPanes({ terminals: TERMINALS });
    try {
      toggle(host, 'h').focus();
      clock.advance(MINUTE);
      service.publish(A_IN_ERRORS);
      service.publish(A_IN_ERRORS.filter(terminal => terminal.launchDirectory !== d('b')));
      await flush();
      expect(listSequenceIn(host, DIRECTORIES))
        .toEqual([heading('errors', 2), d('e'), heading('need a human', 1), d('h'), heading('idle', 0), d('a'), heading('working', 1), d('w')]);
    } finally { dispose(); }
  });

  it('keeps cards in place in Recently used order when another card has a recency interaction, and puts it first once the hold ends', async () => {
    const { host, dispose } = await inRecentlyUsed();
    try {
      toggle(host, 'h').focus();
      toggle(host, 'w').click();
      await flush();
      const frozen = listSequenceIn(host, DIRECTORIES);
      blur();
      await flush();
      expect({ frozen, after: listSequenceIn(host, DIRECTORIES) })
        .toEqual({ frozen: RECENTLY_USED, after: [RECENTLY_USED_HEADING, d('w'), d('e'), d('h'), d('a'), d('b')] });
    } finally { dispose(); }
  });

  it('keeps each card\'s collapsed or expanded state to the collapse rules and a manual choice while frozen', async () => {
    const terminals = [t('e', 'flow-error'), t('a', 'idle'), t('b', 'idle'), t('w', 'working')];
    const { host, service, clock, dispose } = mountControllerPanes({ terminals, oneColumn: true });
    try {
      toggle(host, 'b').click();
      toggle(host, 'e').focus();
      clock.advance(MINUTE);
      service.publish([t('e', 'flow-error'), t('a', 'needs-human'), t('b', 'idle'), t('w', 'working')]);
      await flush();
      const expanded = (name: string) => isExpanded(card(host, name), d(name));
      expect({ list: listSequenceIn(host, directoriesOf(terminals)), expanded: { e: expanded('e'), a: expanded('a'), b: expanded('b'), w: expanded('w') } }).toEqual({
        list: [heading('errors', 1), d('e'), heading('idle', 1), d('a'), d('b'), heading('working', 1), d('w')],
        expanded: { e: true, a: true, b: true, w: false },
      });
    } finally { dispose(); }
  });
});

describe('the end of the last hold', () => {
  it('re-sorts the list at once when focus leaves the held card', async () => {
    const { host, service, clock, dispose } = mountControllerPanes({ terminals: TERMINALS });
    try {
      toggle(host, 'h').focus();
      clock.advance(MINUTE);
      service.publish(A_IN_ERRORS);
      await flush();
      const frozen = listSequenceIn(host, DIRECTORIES);
      blur();
      await flush();
      expect({ frozen, after: listSequenceIn(host, DIRECTORIES), held: heldCardsIn(host, DIRECTORIES) })
        .toEqual({ frozen: [heading('errors', 2), d('e'), heading('need a human', 1), d('h'), heading('idle', 1), d('a'), d('b'), heading('working', 1), d('w')], after: ATTENTION_A_IN_ERRORS, held: [] });
    } finally { dispose(); }
  });

  it('re-sorts the list when the controller window loses focus, keeping keyboard focus on the same control of the card that moves', async () => {
    const { host, service, clock, windowFocus, dispose } = mountControllerPanes({ terminals: TERMINALS });
    try {
      toggle(host, 'h').focus();
      clock.advance(MINUTE);
      service.publish(A_IN_ERRORS);
      await flush();
      const frozen = { list: listSequenceIn(host, DIRECTORIES), held: heldCardsIn(host, DIRECTORIES) };
      windowFocus.set(false);
      await flush();
      expect({ frozen, after: listSequenceIn(host, DIRECTORIES), held: heldCardsIn(host, DIRECTORIES), focusOnH: document.activeElement === toggle(host, 'h') }).toEqual({
        frozen: { list: [heading('errors', 2), d('e'), heading('need a human', 1), d('h'), heading('idle', 1), d('a'), d('b'), heading('working', 1), d('w')], held: [d('h')] },
        after: ATTENTION_A_IN_ERRORS,
        held: [],
        focusOnH: true,
      });
    } finally { dispose(); }
  });

  it('puts a card first in Recently used order once its Bring forward is pressed from the keyboard and the terminal window takes focus', async () => {
    const { host, service, windowFocus, dispose } = await inRecentlyUsed();
    try {
      const bringForward = headerActivationIn(card(host, 'w'));
      if (!bringForward) throw new Error('w offers no Bring forward');
      bringForward.focus();
      bringForward.click();
      await vi.waitFor(() => expect(service.activated).toEqual(['order-w']));
      await flush();
      const frozen = { list: listSequenceIn(host, DIRECTORIES), held: heldCardsIn(host, DIRECTORIES) };
      windowFocus.set(false);
      await flush();
      expect({ frozen, after: listSequenceIn(host, DIRECTORIES), held: heldCardsIn(host, DIRECTORIES) }).toEqual({
        frozen: { list: RECENTLY_USED, held: [d('w')] },
        after: [RECENTLY_USED_HEADING, d('w'), d('e'), d('h'), d('a'), d('b')],
        held: [],
      });
    } finally { dispose(); }
  });

  it('drops a held card that is removed and, as it was the last hold, re-sorts the list at once', async () => {
    const terminals = [t('e', 'flow-error'), t('x', 'disconnected'), t('a', 'idle'), t('w', 'working')];
    const directories = directoriesOf(terminals);
    const { host, service, clock, dispose } = mountControllerPanes({ terminals });
    try {
      const dismiss = dismissIn(card(host, 'x'));
      if (!dismiss) throw new Error('x offers no Dismiss');
      dismiss.focus();
      clock.advance(MINUTE);
      service.publish([t('e', 'flow-error'), t('x', 'disconnected'), t('a', 'idle'), t('w', 'flow-error')]);
      await flush();
      const frozen = { list: listSequenceIn(host, directories), held: heldCardsIn(host, directories) };
      dismissIn(card(host, 'x'))?.click();
      await vi.waitFor(() => expect(service.dismissed).toEqual(['order-x']));
      service.publish([t('e', 'flow-error'), t('a', 'idle'), t('w', 'flow-error')]);
      await flush();
      expect({ frozen, after: listSequenceIn(host, directories) }).toEqual({
        frozen: { list: [heading('errors', 3), d('e'), d('x'), heading('idle', 1), d('a'), heading('working', 0), d('w')], held: [d('x')] },
        after: [heading('errors', 2), d('e'), d('w'), heading('idle', 1), d('a')],
      });
    } finally { dispose(); }
  });
});
