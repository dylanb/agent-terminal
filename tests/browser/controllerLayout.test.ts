import { afterEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import '../helpers/rendererTokens';
import '../../src/renderer/src/styles.css';
import { createViewportLayout } from '../../src/renderer/src/controllerFrame';
import { cardsIn } from '../helpers/controllerCards';
import { mountControllerPanes } from '../helpers/controllerMount';
import { STATUS_CASES, statusTerminal } from '../helpers/controllerStatusFixture';

const DEFAULT_VIEWPORT = { width: window.innerWidth, height: window.innerHeight };

afterEach(async () => {
  document.body.replaceChildren();
  await page.viewport(DEFAULT_VIEWPORT.width, DEFAULT_VIEWPORT.height);
});

describe('the frame layout', () => {
  it('reports one column below 640 CSS px and multi-column at 640, and notifies across that edge', async () => {
    await page.viewport(639, 700);
    const layout = createViewportLayout(window);
    let notified = 0;
    const unsubscribe = layout.onChange(() => { notified += 1; });
    const narrow = layout.oneColumn();
    await page.viewport(640, 700);
    await expect.poll(() => ({ narrow, wide: layout.oneColumn(), notified: notified > 0 }))
      .toEqual({ narrow: true, wide: false, notified: true });
    unsubscribe();
  });
});

const rows = (cards: HTMLElement[]): number => new Set(cards.map(card => Math.round(card.getBoundingClientRect().top))).size;

describe('card columns', () => {
  const terminals = [STATUS_CASES['needs-human'].terminal, STATUS_CASES.working.terminal];

  it('puts two cards side by side when the layout reports multi-column, whatever the viewport', async () => {
    await page.viewport(639, 700);
    const { host, dispose } = mountControllerPanes({ terminals, oneColumn: false });
    try {
      const cards = cardsIn(host);
      expect({ cards: cards.length, rows: rows(cards) }).toEqual({ cards: 2, rows: 1 });
    } finally { dispose(); }
  });

  it('moves the cards into one column and back as the layout reports the change', async () => {
    await page.viewport(900, 700);
    const { host, layout, dispose } = mountControllerPanes({ terminals, oneColumn: false });
    const settledRows = (want: number) => vi.waitFor(() => {
      const count = rows(cardsIn(host));
      if (count !== want) throw new Error('not settled');
      return count;
    }).catch(() => rows(cardsIn(host)));
    try {
      const cards = cardsIn(host).length;
      const wide = await settledRows(1);
      layout.set(true);
      const narrow = await settledRows(2);
      layout.set(false);
      const wideAgain = await settledRows(1);
      expect({ cards, wide, narrow, wideAgain }).toEqual({ cards: 2, wide: 1, narrow: 2, wideAgain: 1 });
    } finally { dispose(); }
  });

  it('puts every card in its own row when the layout reports one column, whatever the viewport', async () => {
    await page.viewport(900, 700);
    const { host, dispose } = mountControllerPanes({ terminals, oneColumn: true });
    try {
      const cards = cardsIn(host);
      expect({ cards: cards.length, rows: rows(cards) }).toEqual({ cards: 2, rows: 2 });
    } finally { dispose(); }
  });
});

/** The document, and every element that scrolls sideways, whose content is wider than its box. */
const horizontalScrollers = (): string[] => [document.documentElement, ...document.body.querySelectorAll<HTMLElement>('*')]
  .filter(element => (element === document.documentElement || ['auto', 'scroll'].includes(getComputedStyle(element).overflowX))
    && element.scrollWidth > element.clientWidth)
  .map(element => `${element.tagName.toLowerCase()}${element.className ? `.${element.className}` : ''} by ${element.scrollWidth - element.clientWidth}px`);

describe('no horizontal scroll', () => {
  const long = statusTerminal({
    ticket: { availability: 'known', number: 219, title: { availability: 'known', text: 'A long issue title that runs on '.repeat(12) } },
    error: { reason: 'A long reason without a single break '.repeat(20) },
  });
  long.launchDirectory = `/work/${'long-worktree-segment-'.repeat(12)}end`;

  it.each([[320, true], [639, true], [640, false]] as const)('does not scroll horizontally at %i CSS px', async (width, oneColumn) => {
    await page.viewport(width, 700);
    const { host, dispose } = mountControllerPanes({ terminals: [long, STATUS_CASES.working.terminal], oneColumn });
    try {
      expect({ cards: cardsIn(host).length, scrolls: horizontalScrollers() }).toEqual({ cards: 2, scrolls: [] });
    } finally { dispose(); }
  });
});

describe('no horizontal scroll with a long card name', () => {
  const named = { ...statusTerminal(), launchDirectory: '/work/agent_terminal_issue_243_collapsible_status_cards', repositoryRoot: '/work/agent_terminal_issue_243_collapsible_status_cards' };

  it('does not scroll horizontally at 320 CSS px when the name has no break points', async () => {
    await page.viewport(320, 700);
    const { host, dispose } = mountControllerPanes({ terminals: [named], oneColumn: true });
    try {
      expect({ cards: cardsIn(host).length, scrolls: horizontalScrollers() }).toEqual({ cards: 1, scrolls: [] });
    } finally { dispose(); }
  });
});
