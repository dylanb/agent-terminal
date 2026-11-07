import { describe, expect, it } from 'vitest';
import { directoryCards } from '../../src/shared/controllerCards';
import { cardList, observeCards, timeInStateText, type CardListEntry, type CardObservations } from '../../src/renderer/src/controllerCardOrder';
import type { ControllerSortMode, ControllerTerminal } from '../../src/shared/ipc';
import { DURATION_TEXTS, ORDER_EXAMPLES, RECENCY_EXAMPLES, RECENT_EXAMPLES, TIME_VERBS, orderDirectory, orderTerminal, type OrderStep } from '../helpers/controllerCardOrderFixture';

const START = 1_000_000_000;

/** The list in `sortMode` after the controller has seen `steps` and the operator used the `used` directories (by
 *  `orderTerminal` name, oldest first), read as the list helper reads the screen. */
function listAfter(steps: readonly OrderStep[], sortMode: ControllerSortMode, used: readonly string[] = []): string[] {
  const recency = new Map(used.map((name, index) => [orderDirectory(name), index + 1]));
  let observations: CardObservations | undefined;
  let cards = directoryCards([]);
  for (const { at, terminals } of steps) {
    cards = directoryCards(terminals);
    observations = observeCards(observations, cards, START + at);
  }
  return cardList(cards, observations!, sortMode, recency).map((entry: CardListEntry) =>
    entry.kind === 'heading' ? [entry.name, entry.count].filter(part => part !== undefined).join(' ') : entry.card.launchDirectory);
}

/** The time-in-state text of the one card `terminal` makes, first seen at START and read `elapsed` ms later. */
function textAfter(terminal: ControllerTerminal, elapsed: number): string {
  const cards = directoryCards([terminal]);
  return timeInStateText(cards[0], observeCards(undefined, cards, START), START + elapsed);
}

describe('the Attention list', () => {
  it.each(Object.entries(ORDER_EXAMPLES))('%s', (_, { steps, list }) => {
    expect(listAfter(steps, 'attention')).toEqual(list);
  });
});

describe('the Recently used list', () => {
  it.each(Object.entries(RECENT_EXAMPLES))('%s', (_, { steps, list }) => {
    expect(listAfter(steps, 'recently-used')).toEqual(list);
  });
});

describe('the list with recency', () => {
  it.each(Object.entries(RECENCY_EXAMPLES))('%s', (_, { steps, used, sortMode, list }) => {
    expect(listAfter(steps, sortMode, used)).toEqual(list);
  });
});

describe('the time-in-state text', () => {
  it.each(DURATION_TEXTS)('reads %i ms in a group as "for %s"', (elapsed, text) => {
    expect(textAfter(orderTerminal('a', 'idle'), elapsed)).toBe(`for ${text}`);
  });

  it.each(TIME_VERBS)('reads a %s card\'s time with "%s"', (status, verb) => {
    expect(textAfter(orderTerminal('a', status), 41 * 60_000)).toBe(`${verb} 41m`);
  });

  it('reads "under 1m", never a negative time, when the clock is earlier than the card\'s entry into its group', () => {
    expect(textAfter(orderTerminal('a', 'needs-human'), -5 * 60_000)).toBe('waiting under 1m');
  });

  it('restarts at "under 1m" when the card changes group, and keeps counting while it stays', () => {
    const before = directoryCards([orderTerminal('a', 'idle'), orderTerminal('b', 'idle')]);
    const first = observeCards(undefined, before, START);
    const after = directoryCards([orderTerminal('a', 'working'), orderTerminal('b', 'idle')]);
    const second = observeCards(first, after, START + 7 * 60_000);
    expect({ a: timeInStateText(after[0], second, START + 7 * 60_000), b: timeInStateText(after[1], second, START + 7 * 60_000) })
      .toEqual({ a: 'running under 1m', b: 'for 7m' });
  });

  it('keeps no card the snapshot no longer holds', () => {
    const first = observeCards(undefined, directoryCards([orderTerminal('a', 'idle')]), START);
    const second = observeCards(first, directoryCards([]), START + 60_000);
    const back = directoryCards([orderTerminal('a', 'idle')]);
    const third = observeCards(second, back, START + 9 * 60_000);
    expect(timeInStateText(back[0], third, START + 9 * 60_000)).toBe('for under 1m');
  });
});
