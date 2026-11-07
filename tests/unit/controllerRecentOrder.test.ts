// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ControllerTerminal } from '../../src/shared/ipc';
import {
  cardHeadingLevelsIn, cardsIn, controlName, listSequenceIn, selectedSortOptionsIn, sortOptionIn, type SortOption,
} from '../helpers/controllerCards';
import { RECENTLY_USED_HEADING, SORT_SENTENCES, heading, orderDirectory as d, orderTerminal as t } from '../helpers/controllerCardOrderFixture';
import { mountControllerPanes } from '../helpers/controllerMount';
import { SORT_MODES, type SortMode } from '../helpers/controllerStatusFixture';

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
