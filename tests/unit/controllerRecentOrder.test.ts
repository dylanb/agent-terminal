// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ControllerTerminal } from '../../src/shared/ipc';
import {
  cardHeaderIn, cardHeadingLevelsIn, cardIn, cardsIn, clearHistoryIn, controlName, dismissIn, dismissLoopMessageIn, headerActivationIn,
  listSequenceIn, selectedSortOptionsIn, sortOptionIn, type SortOption,
} from '../helpers/controllerCards';
import { RECENTLY_USED_HEADING, SORT_SENTENCES, heading, orderDirectory as d, orderPeer, orderTerminal as t } from '../helpers/controllerCardOrderFixture';
import { notificationItem, statusItem } from '../helpers/controllerHistory';
import { mountControllerPanes } from '../helpers/controllerMount';
import { SORT_MODES, type SortMode, type StatusCaseKey } from '../helpers/controllerStatusFixture';

afterEach(() => document.body.replaceChildren());

const MINUTE = 60_000;
const directoriesOf = (terminals: readonly ControllerTerminal[]): string[] => [...new Set(terminals.map(terminal => terminal.launchDirectory))];
const listOf = (host: HTMLElement, terminals: readonly ControllerTerminal[]) => listSequenceIn(host, directoriesOf(terminals));

/** Waits for the sort control to be shown and returns its option `name`; a control that never shows throws. */
const sortOption = (host: HTMLElement, name: SortOption): Promise<HTMLElement> => vi.waitFor(() => {
  const option = sortOptionIn(host, name);
  if (!option) throw new Error(`the ${name} sort option is not shown yet`);
  return option;
});

/** The window's text outside any hidden element. */
function shownText(host: HTMLElement): string {
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  let text = '';
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.parentElement?.closest('[hidden]')) text += node.textContent ?? '';
  }
  return text;
}

/** Which of the two order sentences the window shows, by their order. */
const sentencesShown = (host: HTMLElement): SortMode[] =>
  SORT_MODES.filter(mode => shownText(host).includes(SORT_SENTENCES[mode]));

const LIVE_REGION = '[aria-live]:not([aria-live="off"]), [role="status"], [role="alert"], [role="log"], [role="marquee"], [role="timer"]';
/** The order sentences shown inside a live region, which a screen reader would announce on each change. */
const sentencesAnnounced = (host: HTMLElement): SortMode[] => SORT_MODES.filter(mode =>
  [...host.querySelectorAll('*')].some(element => (element.textContent ?? '').includes(SORT_SENTENCES[mode]) && element.closest(LIVE_REGION)));

/** The screen once a change has had time to land: the list, the selected option and the sentence shown. */
const settled = async (host: HTMLElement, terminals: readonly ControllerTerminal[], expected: { list: string[]; selected: SortOption; sentence: SortMode }) => {
  const read = () => ({ list: listOf(host, terminals), selected: selectedSortOptionsIn(host), sentences: sentencesShown(host) });
  const want = { list: expected.list, selected: [expected.selected], sentences: [expected.sentence] };
  await vi.waitFor(() => expect(read()).toEqual(want)).catch(() => undefined);
  return read();
};

/** Every change made under the window's live regions, from the moment it is created. */
function regionChanges(host: HTMLElement): () => MutationRecord[] {
  const observer = new MutationObserver(() => {});
  for (const region of host.querySelectorAll('[role="status"], [role="alert"]')) {
    observer.observe(region, { childList: true, characterData: true, subtree: true, attributes: true });
  }
  return () => observer.takeRecords();
}

/** Cards in three groups, registered in an order that is not their Attention order. */
const TERMINALS = [t('i1', 'idle'), t('w1', 'working'), t('e1', 'flow-error'), t('i2', 'idle'), t('h1', 'needs-human')];
const ATTENTION = [heading('errors', 1), d('e1'), heading('need a human', 1), d('h1'), heading('idle', 2), d('i1'), d('i2'), heading('working', 1), d('w1')];
const RECENTLY_USED = [RECENTLY_USED_HEADING, d('e1'), d('h1'), d('i1'), d('i2'), d('w1')];

describe('the sort control in the window header', () => {
  it('starts in Attention order, with Attention selected and the Attention sentence beneath the header', async () => {
    const { host, dispose } = mountControllerPanes({ terminals: TERMINALS });
    try {
      await sortOption(host, 'Attention');
      expect(await settled(host, TERMINALS, { list: ATTENTION, selected: 'Attention', sentence: 'attention' }))
        .toEqual({ list: ATTENTION, selected: ['Attention'], sentences: ['attention'] });
    } finally { dispose(); }
  });

  it('re-sorts at once to one Recently used heading over every card in Attention order when Recently used is pressed, and back to the group headings when Attention is pressed', async () => {
    const { host, dispose } = mountControllerPanes({ terminals: TERMINALS });
    try {
      (await sortOption(host, 'Recently used')).click();
      const recent = await settled(host, TERMINALS, { list: RECENTLY_USED, selected: 'Recently used', sentence: 'recently-used' });
      (await sortOption(host, 'Attention')).click();
      const attention = await settled(host, TERMINALS, { list: ATTENTION, selected: 'Attention', sentence: 'attention' });
      expect({ recent, attention }).toEqual({
        recent: { list: RECENTLY_USED, selected: ['Recently used'], sentences: ['recently-used'] },
        attention: { list: ATTENTION, selected: ['Attention'], sentences: ['attention'] },
      });
    } finally { dispose(); }
  });

  it('re-sorts when the order is chosen from the keyboard with the arrow keys', async () => {
    const { host, dispose } = mountControllerPanes({ terminals: TERMINALS });
    try {
      const attention = await sortOption(host, 'Attention');
      attention.focus();
      attention.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
      expect(await settled(host, TERMINALS, { list: RECENTLY_USED, selected: 'Recently used', sentence: 'recently-used' }))
        .toEqual({ list: RECENTLY_USED, selected: ['Recently used'], sentences: ['recently-used'] });
    } finally { dispose(); }
  });

  it('keeps Recently used order through a live snapshot, placing a card that changes group by its new Attention place', async () => {
    const { host, service, clock, dispose } = mountControllerPanes({ terminals: TERMINALS });
    try {
      (await sortOption(host, 'Recently used')).click();
      clock.advance(MINUTE);
      const after = [t('i1', 'flow-error'), ...TERMINALS.slice(1)];
      service.publish(after);
      const expected = [RECENTLY_USED_HEADING, d('e1'), d('i1'), d('h1'), d('i2'), d('w1')];
      expect(await settled(host, after, { list: expected, selected: 'Recently used', sentence: 'recently-used' }))
        .toEqual({ list: expected, selected: ['Recently used'], sentences: ['recently-used'] });
    } finally { dispose(); }
  });

  it('reports the Recently used heading as a level-2 heading and each card name as a level-3 heading beneath it', async () => {
    const { host, dispose } = mountControllerPanes({ terminals: TERMINALS });
    try {
      (await sortOption(host, 'Recently used')).click();
      const { list } = await settled(host, TERMINALS, { list: RECENTLY_USED, selected: 'Recently used', sentence: 'recently-used' });
      expect({ list, cardLevels: cardsIn(host).map(card => cardHeadingLevelsIn(card)) })
        .toEqual({ list: RECENTLY_USED, cardLevels: TERMINALS.map(() => [3]) });
    } finally { dispose(); }
  });

  it('keeps focus on the pressed option across the re-sort it starts', async () => {
    const { host, dispose } = mountControllerPanes({ terminals: TERMINALS });
    try {
      const recent = await sortOption(host, 'Recently used');
      recent.focus();
      recent.click();
      const { list } = await settled(host, TERMINALS, { list: RECENTLY_USED, selected: 'Recently used', sentence: 'recently-used' });
      expect.soft(list).toEqual(RECENTLY_USED);
      expect(controlName(document.activeElement).trim(), 'the focused control').toBe('Recently used');
    } finally { dispose(); }
  });

  it('announces nothing when the order changes', async () => {
    const { host, dispose } = mountControllerPanes({ terminals: TERMINALS });
    try {
      const recent = await sortOption(host, 'Recently used');
      const changes = regionChanges(host);
      recent.click();
      const { list, sentences } = await settled(host, TERMINALS, { list: RECENTLY_USED, selected: 'Recently used', sentence: 'recently-used' });
      expect.soft({ list, sentences }).toEqual({ list: RECENTLY_USED, sentences: ['recently-used'] });
      expect({ regionChanges: changes(), sentencesAnnounced: sentencesAnnounced(host) }).toEqual({ regionChanges: [], sentencesAnnounced: [] });
    } finally { dispose(); }
  });
});

/** `name`'s status-case terminal with a history entry and a Clear history target, so its card offers Clear history. */
function withHistory(name: string, status: StatusCaseKey): ControllerTerminal {
  return { ...t(name, status), timeline: [statusItem(`${name} went quiet`, 1_000)], clearHistoryTarget: { id: `order-${name}`, launchDirectory: d(name), revision: 'r1' } };
}

/** Cards in all four groups, with a duplicate-directory card, a loop error and a card offering Clear history, so every
 *  recency control shows; registered in an order that is not their Attention order. */
const USE_TERMINALS = [
  t('i1', 'idle'), withHistory('e1', 'flow-error'), t('w1', 'working'), t('dup', 'idle'), orderPeer('dup', 'idle'),
  t('l1', 'loop-error'), t('i2', 'idle'), withHistory('h1', 'needs-human'),
];
const USE_DIRECTORIES = directoriesOf(USE_TERMINALS);
const USE_ATTENTION_CARDS = [d('e1'), d('dup'), d('l1'), d('h1'), d('i1'), d('i2'), d('w1')];
/** The Recently used list once the `used` directories had a recency interaction, most recent first. */
const recentlyUsed = (...used: string[]): string[] => [RECENTLY_USED_HEADING, ...used, ...USE_ATTENTION_CARDS.filter(card => !used.includes(card))];

/** Mounts the window over `terminals` in Recently used order, once the list shows it. */
async function inRecentlyUsed(options: { terminals: ControllerTerminal[]; activation?: 'rejected' }) {
  const mounted = mountControllerPanes(options);
  (await sortOption(mounted.host, 'Recently used')).click();
  await vi.waitFor(() => expect(selectedSortOptionsIn(mounted.host)).toEqual(['Recently used']));
  return mounted;
}

/** Presses `control`, then moves focus out of it, so the card it sits on is not held when the order is read. */
const press = (control: HTMLElement | undefined): void => {
  if (!control) throw new Error('the control to press is not shown');
  control.click();
  (document.activeElement as HTMLElement | null)?.blur();
};
const card = (host: HTMLElement, name: string): HTMLElement => {
  const found = cardIn(host, d(name));
  if (!found) throw new Error(`no card for ${d(name)}`);
  return found;
};
/** The list once it reads `expected`, or as it reads when it does not settle there. */
const listSettled = async (host: HTMLElement, directories: readonly string[], expected: readonly string[]): Promise<string[]> => {
  await vi.waitFor(() => expect(listSequenceIn(host, directories)).toEqual(expected)).catch(() => undefined);
  return listSequenceIn(host, directories);
};

describe('recency from a card\'s own controls', () => {
  const controls: Array<[string, string, (host: HTMLElement) => HTMLElement | undefined]> = [
    ['header collapse/expand toggle', 'i2', host => cardHeaderIn(card(host, 'i2'), d('i2'))],
    ['Bring forward', 'w1', host => headerActivationIn(card(host, 'w1'))],
    ['Bring all N terminals forward', 'dup', host => headerActivationIn(card(host, 'dup'))],
    ['Clear history', 'h1', host => clearHistoryIn(card(host, 'h1'))],
  ];
  it.each(controls)('puts a card first in Recently used order once the operator presses its %s', async (_, name, control) => {
    const { host, dispose } = await inRecentlyUsed({ terminals: USE_TERMINALS });
    try {
      press(control(host));
      expect(await listSettled(host, USE_DIRECTORIES, recentlyUsed(d(name)))).toEqual(recentlyUsed(d(name)));
    } finally { dispose(); }
  });

  it('puts a card first once its Bring forward is pressed, though bringing the terminal forward fails', async () => {
    const { host, service, dispose } = await inRecentlyUsed({ terminals: USE_TERMINALS, activation: 'rejected' });
    try {
      press(headerActivationIn(card(host, 'w1')));
      await vi.waitFor(() => expect(service.activated).toEqual(['order-w1']));
      await vi.waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/^Terminal unavailable/));
      expect(await listSettled(host, USE_DIRECTORIES, recentlyUsed(d('w1')))).toEqual(recentlyUsed(d('w1')));
    } finally { dispose(); }
  });

  it('puts the most recently used card first, then the card used before it, then every other card in Attention order', async () => {
    const { host, dispose } = await inRecentlyUsed({ terminals: USE_TERMINALS });
    try {
      press(cardHeaderIn(card(host, 'i2'), d('i2')));
      press(headerActivationIn(card(host, 'w1')));
      expect(await listSettled(host, USE_DIRECTORIES, recentlyUsed(d('w1'), d('i2')))).toEqual(recentlyUsed(d('w1'), d('i2')));
    } finally { dispose(); }
  });

  it('counts a press made in Attention order once Recently used is selected', async () => {
    const { host, dispose } = mountControllerPanes({ terminals: USE_TERMINALS });
    try {
      await sortOption(host, 'Attention');
      press(cardHeaderIn(card(host, 'i2'), d('i2')));
      (await sortOption(host, 'Recently used')).click();
      expect(await listSettled(host, USE_DIRECTORIES, recentlyUsed(d('i2')))).toEqual(recentlyUsed(d('i2')));
    } finally { dispose(); }
  });

  it('counts dismissing a loop message as a use, which keeps the card\'s recency through the change of group it makes', async () => {
    const { host, service, dispose } = await inRecentlyUsed({ terminals: USE_TERMINALS });
    try {
      press(dismissLoopMessageIn(card(host, 'l1')));
      await vi.waitFor(() => expect(service.loopMessageDismissals).toEqual([['order-l1', 'loop-1']]));
      press(cardHeaderIn(card(host, 'i2'), d('i2')));
      const expected = [RECENTLY_USED_HEADING, d('i2'), d('l1'), d('e1'), d('dup'), d('h1'), d('i1'), d('w1')];
      expect(await listSettled(host, USE_DIRECTORIES, expected)).toEqual(expected);
    } finally { dispose(); }
  });

  it('leaves recency unchanged when the sort order changes or a terminal reports a status or a notification', async () => {
    const { host, service, clock, dispose } = await inRecentlyUsed({ terminals: USE_TERMINALS });
    try {
      press(cardHeaderIn(card(host, 'i2'), d('i2')));
      const used = await listSettled(host, USE_DIRECTORIES, recentlyUsed(d('i2')));
      (await sortOption(host, 'Attention')).click();
      (await sortOption(host, 'Recently used')).click();
      clock.advance(MINUTE);
      const reported = USE_TERMINALS.map(terminal =>
        terminal.id === 'order-w1' ? { ...t('w1', 'needs-human'), timeline: [notificationItem('w1 needs you', 2_000)] }
          : terminal.id === 'order-i1' ? { ...terminal, timeline: [notificationItem('i1 finished', 2_000)] } : terminal);
      service.publish(reported);
      const expected = [RECENTLY_USED_HEADING, d('i2'), d('e1'), d('dup'), d('l1'), d('h1'), d('w1'), d('i1')];
      const after = listSequenceIn(host, USE_DIRECTORIES);
      expect({ used, after }).toEqual({ used: recentlyUsed(d('i2')), after: expected });
    } finally { dispose(); }
  });

  it('keeps a card\'s recency while it disconnects, reconnects and enters and leaves a duplicate-directory overlap', async () => {
    const terminals = [t('e1', 'flow-error'), t('x', 'idle'), t('i1', 'idle')];
    const directories = directoriesOf(terminals);
    const { host, service, clock, dispose } = await inRecentlyUsed({ terminals });
    try {
      press(cardHeaderIn(card(host, 'x'), d('x')));
      const used = [RECENTLY_USED_HEADING, d('x'), d('e1'), d('i1')];
      const lists: Array<[string, string[]]> = [['used', await listSettled(host, directories, used)]];
      const steps: Array<[string, ControllerTerminal[]]> = [
        ['disconnected', [t('e1', 'flow-error'), t('x', 'disconnected'), t('i1', 'idle')]],
        ['reconnected', [t('e1', 'flow-error'), { ...t('x', 'idle'), id: 'order-x-again' }, t('i1', 'idle')]],
        ['overlapping', [t('e1', 'flow-error'), { ...t('x', 'idle'), id: 'order-x-again' }, orderPeer('x', 'idle'), t('i1', 'idle')]],
        ['overlap left', [t('e1', 'flow-error'), orderPeer('x', 'idle'), t('i1', 'idle')]],
      ];
      for (const [step, snapshot] of steps) {
        clock.advance(MINUTE);
        service.publish(snapshot);
        lists.push([step, listSequenceIn(host, directories)]);
      }
      expect(lists).toEqual([['used', used], ...steps.map(([step]): [string, string[]] => [step, used])]);
    } finally { dispose(); }
  });

  it('forgets a card\'s recency when its disconnected card is dismissed, so a terminal registering again in that directory is untouched', async () => {
    const terminals = [t('e1', 'flow-error'), t('x', 'idle'), t('i1', 'idle')];
    const directories = directoriesOf(terminals);
    const { host, service, clock, dispose } = await inRecentlyUsed({ terminals });
    try {
      press(cardHeaderIn(card(host, 'x'), d('x')));
      const used = await listSettled(host, directories, [RECENTLY_USED_HEADING, d('x'), d('e1'), d('i1')]);
      expect.soft(used, 'the used card first before it disconnects').toEqual([RECENTLY_USED_HEADING, d('x'), d('e1'), d('i1')]);
      clock.advance(MINUTE);
      service.publish([t('e1', 'flow-error'), t('x', 'disconnected'), t('i1', 'idle')]);
      press(dismissIn(card(host, 'x')));
      await vi.waitFor(() => expect(service.dismissed).toEqual(['order-x']));
      clock.advance(MINUTE);
      service.publish([t('e1', 'flow-error'), t('i1', 'idle'), { ...t('x', 'idle'), id: 'order-x-again' }]);
      expect(listSequenceIn(host, directories)).toEqual([RECENTLY_USED_HEADING, d('e1'), d('i1'), d('x')]);
    } finally { dispose(); }
  });

  it('announces nothing when a press re-sorts the list', async () => {
    const { host, dispose } = await inRecentlyUsed({ terminals: USE_TERMINALS });
    try {
      const changes = regionChanges(host);
      press(cardHeaderIn(card(host, 'i2'), d('i2')));
      expect.soft(await listSettled(host, USE_DIRECTORIES, recentlyUsed(d('i2')))).toEqual(recentlyUsed(d('i2')));
      expect(changes()).toEqual([]);
    } finally { dispose(); }
  });
});
