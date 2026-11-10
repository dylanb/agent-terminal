import { describe, expect, it } from 'vitest';
import { directoryCards } from '../../src/shared/controllerCards';
import { createCardOrder, type CardListEntry } from '../../src/renderer/src/controllerCardOrder';
import type { ControllerSortMode, ControllerTerminal } from '../../src/shared/ipc';
import { DURATION_TEXTS, ORDER_EXAMPLES, RECENCY_EXAMPLES, RECENT_EXAMPLES, TIME_VERBS, orderDirectory, orderTerminal, type OrderStep } from '../helpers/controllerCardOrderFixture';

const START = 1_000_000_000;

/** The list in `sortMode` after the controller has seen `steps` and the operator used the `used` directories (by
 *  `orderTerminal` name, oldest first), read as the list helper reads the screen. */
function listAfter(steps: readonly OrderStep[], sortMode: ControllerSortMode, used: readonly string[] = []): string[] {
  const recency = new Map(used.map((name, index) => [orderDirectory(name), index + 1]));
  const order = createCardOrder();
  for (const { at, terminals } of steps) order.observe(directoryCards(terminals), START + at);
  return order.list(sortMode, recency, false).map((entry: CardListEntry) =>
    entry.kind === 'card' ? entry.card.launchDirectory : entry.kind === 'group' ? `${entry.name} ${entry.count}` : entry.name);
}

/** The time-in-state text of the one card `terminal` makes, first seen at START and read `elapsed` ms later. */
function textAfter(terminal: ControllerTerminal, elapsed: number): string {
  const cards = directoryCards([terminal]);
  const order = createCardOrder();
  order.observe(cards, START);
  return order.timeInState(cards[0], START + elapsed);
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
    const order = createCardOrder();
    order.observe(directoryCards([orderTerminal('a', 'idle'), orderTerminal('b', 'idle')]), START);
    const after = directoryCards([orderTerminal('a', 'working'), orderTerminal('b', 'idle')]);
    order.observe(after, START + 7 * 60_000);
    expect({ a: order.timeInState(after[0], START + 7 * 60_000), b: order.timeInState(after[1], START + 7 * 60_000) })
      .toEqual({ a: 'running under 1m', b: 'for 7m' });
  });

  it('keeps no card the snapshot no longer holds', () => {
    const order = createCardOrder();
    order.observe(directoryCards([orderTerminal('a', 'idle')]), START);
    order.observe(directoryCards([]), START + 60_000);
    const back = directoryCards([orderTerminal('a', 'idle')]);
    order.observe(back, START + 9 * 60_000);
    expect(order.timeInState(back[0], START + 9 * 60_000)).toBe('for under 1m');
  });
});
