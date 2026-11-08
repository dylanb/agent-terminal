// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ControllerTerminal } from '../../src/shared/ipc';
import {
  cardHeaderIn, cardHeadingLevelsIn, cardIn, cardsIn, headerLabels, headerStatusIn, isExpanded, listSequenceIn, themeControlIn,
  unshownCounts, windowHeaderIn,
} from '../helpers/controllerCards';
import { heading, orderDirectory as d, orderPeer, orderTerminal as t } from '../helpers/controllerCardOrderFixture';
import { mountControllerPanes } from '../helpers/controllerMount';
import { STATUS_CASES, SUMMARY_LABELS, directoryConflictFixture, type SummaryLabel } from '../helpers/controllerStatusFixture';

afterEach(() => document.body.replaceChildren());

const MINUTE = 60_000;
const directoriesOf = (terminals: readonly ControllerTerminal[]): string[] => [...new Set(terminals.map(terminal => terminal.launchDirectory))];
const listOf = (host: HTMLElement, terminals: readonly ControllerTerminal[]) => listSequenceIn(host, directoriesOf(terminals));
const headerOf = (host: HTMLElement, directory: string): string => {
  const card = cardIn(host, directory);
  return card ? headerStatusIn(card, directory) : `no card for ${directory}`;
};
const toggleOf = (host: HTMLElement, directory: string): HTMLElement | undefined => {
  const card = cardIn(host, directory);
  return card ? cardHeaderIn(card, directory) : undefined;
};
const counted = (counts: Partial<Record<SummaryLabel, number>>) => (label: string): number => counts[label as SummaryLabel] ?? 0;

/** Every change made under the window's live regions, from the moment it is created. */
function regionChanges(host: HTMLElement): () => MutationRecord[] {
  const observer = new MutationObserver(() => {});
  for (const region of host.querySelectorAll('[role="status"], [role="alert"]')) {
    observer.observe(region, { childList: true, characterData: true, subtree: true, attributes: true });
  }
  return () => observer.takeRecords();
}

const PLACEMENTS = [
  ['the document body', () => document.body],
  ['a frame nested inside another frame', () => {
    const outer = document.body.appendChild(document.createElement('div'));
    return outer.appendChild(document.createElement('section'));
  }],
] as const;

describe.each(PLACEMENTS)('the controller panes mounted in %s', (_, parent) => {
  it('lists the cards under group headings in group order, each counted as the window header counts it, the card longest in its group first', () => {
    const before = [
      t('a', 'idle'), t('b', 'flow-error'), t('c', 'needs-human'), t('d', 'working'), t('e', 'idle'),
      t('f', 'idle'), t('g', 'working'), t('h', 'working'), t('i', 'working'), t('k', 'idle'),
    ];
    const { host, service, clock, dispose } = mountControllerPanes({ terminals: before, parent: parent() });
    try {
      clock.advance(5 * MINUTE);
      const after = [t('a', 'flow-error'), ...before.slice(1)];
      service.publish(after);
      expect.soft(listOf(host, after)).toEqual([
        heading('errors', 2), d('b'), d('a'),
        heading('need a human', 1), d('c'),
        heading('idle', 3), d('e'), d('f'), d('k'),
        heading('working', 4), d('d'), d('g'), d('h'), d('i'),
      ]);
      expect(unshownCounts(windowHeaderIn(host)?.textContent ?? '', headerLabels(counted({ errors: 2, 'need a human': 1, idle: 3, working: 4 }), 10, 10)))
        .toEqual([]);
    } finally { dispose(); }
  });
});

describe('Attention order', () => {
  it('puts each status case, and a duplicate-directory card, under the heading of its status group', () => {
    const cases = Object.values(STATUS_CASES);
    const { members } = directoryConflictFixture();
    const terminals = [...cases.map(c => c.terminal), ...members];
    const { host, dispose } = mountControllerPanes({ terminals });
    try {
      const expected = SUMMARY_LABELS.flatMap(label => {
        const directories = [
          ...cases.filter(c => c.summary === label).map(c => c.terminal.launchDirectory),
          ...(label === 'errors' ? [members[0].launchDirectory] : []),
        ];
        return directories.length ? [heading(label, directories.length), ...directories] : [];
      });
      expect(listOf(host, terminals)).toEqual(expected);
    } finally { dispose(); }
  });

  it('moves a card that changes group into its new group at once, after the cards already there', () => {
    const before = [t('a', 'idle'), t('b', 'needs-human'), t('c', 'needs-human')];
    const { host, service, clock, dispose } = mountControllerPanes({ terminals: before });
    try {
      expect.soft(listOf(host, before)).toEqual([heading('need a human', 2), d('b'), d('c'), heading('idle', 1), d('a')]);
      clock.advance(10 * MINUTE);
      const after = [t('a', 'needs-human'), before[1], before[2]];
      service.publish(after);
      expect(listOf(host, after)).toEqual([heading('need a human', 3), d('b'), d('c'), d('a')]);
    } finally { dispose(); }
  });

  it('reports each group heading as a level-2 heading and each card name as a level-3 heading beneath it', () => {
    const terminals = [t('a', 'idle'), t('b', 'flow-error'), t('c', 'idle')];
    const { host, dispose } = mountControllerPanes({ terminals });
    try {
      expect.soft(listOf(host, terminals)).toEqual([heading('errors', 1), d('b'), heading('idle', 2), d('a'), d('c')]);
      expect(cardsIn(host).map(card => cardHeadingLevelsIn(card))).toEqual([[3], [3], [3]]);
    } finally { dispose(); }
  });
});

describe('time in state', () => {
  it('shows each card\'s time in state after its written status, expanded or collapsed, and advances it on a clock tick with no status update', () => {
    const terminals = [t('h', 'needs-human'), t('w', 'working')];
    const { host, clock, dispose } = mountControllerPanes({ terminals });
    try {
      clock.advance(41 * MINUTE);
      const expanded = { h: headerOf(host, d('h')), w: headerOf(host, d('w')) };
      toggleOf(host, d('w'))?.click();
      clock.advance(61 * MINUTE);
      const collapsed = { h: headerOf(host, d('h')), w: headerOf(host, d('w')), wExpanded: isExpanded(cardIn(host, d('w'))!, d('w')) };
      expect({ expanded, collapsed }).toEqual({
        expanded: { h: expect.stringMatching(/Needs a human · Idle · waiting 41m$/), w: expect.stringMatching(/Working · running 41m$/) },
        collapsed: { h: expect.stringMatching(/Needs a human · Idle · waiting 1h 42m$/), w: expect.stringMatching(/Working · running 1h 42m$/), wExpanded: false },
      });
    } finally { dispose(); }
  });

  it('restarts at under 1m on a group change and when a disconnected card\'s terminal registers again, but not on a change within the group', () => {
    const { host, service, clock, dispose } = mountControllerPanes({ terminals: [t('p', 'idle'), t('x', 'disconnected'), t('y', 'flow-error')] });
    try {
      clock.advance(7 * MINUTE);
      service.publish([t('p', 'working'), t('x', 'idle'), orderPeer('x', 'idle'), t('y', 'flow-error'), orderPeer('y', 'flow-error')]);
      expect({ p: headerOf(host, d('p')), x: headerOf(host, d('x')), y: headerOf(host, d('y')) }).toEqual({
        p: expect.stringMatching(/Working · running under 1m$/),
        x: expect.stringMatching(/Duplicate directory · 2 instances · for under 1m$/),
        y: expect.stringMatching(/Duplicate directory · 2 instances · for 7m$/),
      });
    } finally { dispose(); }
  });

  it('announces nothing when the time in state advances', () => {
    const { host, clock, dispose } = mountControllerPanes({ terminals: [t('h', 'needs-human')] });
    try {
      const changes = regionChanges(host);
      clock.advance(3 * MINUTE);
      expect.soft(headerOf(host, d('h'))).toMatch(/Needs a human · Idle · waiting 3m$/);
      expect(changes()).toEqual([]);
    } finally { dispose(); }
  });

  it('stops following the clock when disposed', () => {
    const { clock, dispose } = mountControllerPanes({ terminals: [t('a', 'idle')] });
    expect.soft(clock.ticking(), 'follows the clock while mounted').toBe(true);
    dispose();
    expect(clock.ticking(), 'follows the clock once disposed').toBe(false);
  });
});

describe('a re-sort', () => {
  it('announces nothing when a card moves to another group through a change no card condition announces', () => {
    const { host, service, clock, dispose } = mountControllerPanes({ terminals: [t('a', 'idle'), t('b', 'idle')] });
    try {
      const changes = regionChanges(host);
      clock.advance(MINUTE);
      const after = [t('a', 'working'), t('b', 'idle')];
      service.publish(after);
      expect.soft(listOf(host, after)).toEqual([heading('idle', 1), d('b'), heading('working', 1), d('a')]);
      expect(changes()).toEqual([]);
    } finally { dispose(); }
  });

  it('keeps focus on the same control of a card that moves to its new place', () => {
    const before = [t('a', 'idle'), t('w1', 'working'), t('b', 'flow-error'), t('c', 'idle'), t('c2', 'idle'), t('w2', 'working')];
    const { host, service, clock, dispose } = mountControllerPanes({ terminals: before, windowFocused: false });
    try {
      toggleOf(host, d('a'))?.focus();
      clock.advance(MINUTE);
      const after = [t('a', 'working'), ...before.slice(1)];
      service.publish(after);
      expect.soft(listOf(host, after)).toEqual([heading('errors', 1), d('b'), heading('idle', 2), d('c'), d('c2'), heading('working', 3), d('w1'), d('w2'), d('a')]);
      expect(document.activeElement === toggleOf(host, d('a')), 'focus on the moved card\'s header').toBe(true);
    } finally { dispose(); }
  });

  it('leaves focus outside the cards where it is', async () => {
    const before = [t('a', 'idle'), t('b', 'idle')];
    const { host, service, clock, dispose } = mountControllerPanes({ terminals: before });
    try {
      const theme = await vi.waitFor(() => {
        const control = themeControlIn(host);
        if (!control) throw new Error('the theme control is not shown yet');
        return control;
      });
      theme.focus();
      clock.advance(MINUTE);
      const after = [t('a', 'working'), t('b', 'idle')];
      service.publish(after);
      expect.soft(listOf(host, after)).toEqual([heading('idle', 1), d('b'), heading('working', 1), d('a')]);
      expect(document.activeElement === theme, 'focus on the theme control').toBe(true);
    } finally { dispose(); }
  });

  it('keeps each card\'s collapsed or expanded state, a manual choice included, when cards move', () => {
    const before = [t('b', 'idle'), t('a', 'needs-human'), t('c', 'needs-human'), t('c2', 'needs-human'), t('w1', 'working'), t('w2', 'working')];
    const { host, service, clock, dispose } = mountControllerPanes({ terminals: before, oneColumn: true, windowFocused: false });
    try {
      toggleOf(host, d('b'))?.click();
      toggleOf(host, d('a'))?.click();
      clock.advance(MINUTE);
      const after = [t('b', 'working'), t('a', 'flow-error'), ...before.slice(2)];
      service.publish(after);
      expect.soft(listOf(host, after)).toEqual([heading('errors', 1), d('a'), heading('need a human', 2), d('c'), d('c2'), heading('working', 3), d('w1'), d('w2'), d('b')]);
      const expanded = (name: string) => isExpanded(cardIn(host, d(name))!, d(name));
      expect({ a: expanded('a'), b: expanded('b'), c: expanded('c'), w1: expanded('w1') }).toEqual({ a: false, b: true, c: true, w1: false });
    } finally { dispose(); }
  });
});
