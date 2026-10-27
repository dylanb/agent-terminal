import { afterEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import '../../src/renderer/src/tokens.css';
import '../../src/renderer/src/styles.css';
import { cardHeaderIn, cardIn, cardNamedLocator, headerLabels, paintedStatusIn, statusRowIn, unshownCounts, windowHeaderIn } from '../helpers/controllerCards';
import { mountControllerPanes } from '../helpers/controllerMount';
import { STATUS_CASES, type StatusCase } from '../helpers/controllerStatusFixture';

afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.removeAttribute('data-theme');
});

const cases = Object.entries(STATUS_CASES);
const conditionCases = cases.filter(([, c]) => c.terminal.status !== 'disconnected' && Boolean(c.terminal.work?.attention || c.terminal.work?.error));
const directoryOf = (c: StatusCase): string => c.terminal.launchDirectory;

/** Clicks each case's card header, so a card that starts open is collapsed. */
function collapse(host: HTMLElement, rows: ReadonlyArray<[string, StatusCase]>): void {
  for (const [, c] of rows) {
    const card = cardIn(host, directoryOf(c));
    (card && cardHeaderIn(card, directoryOf(c)))?.click();
  }
}

const collapsed = (card: HTMLElement | undefined, directory: string): boolean =>
  Boolean(card) && cardHeaderIn(card!, directory)?.getAttribute('aria-expanded') === 'false';

const summaryCounts = (rows: readonly StatusCase[]) =>
  headerLabels(label => rows.filter(c => c.summary === label).length, rows.length, rows.filter(c => c.terminal.status !== 'disconnected').length);

describe.each(['light', 'dark'])('every status row in the %s theme', theme => {
  it('shows its written status open and collapsed, painted in its status class, and counts it under its summary label', () => {
    document.documentElement.setAttribute('data-theme', theme);
    const { host, dispose } = mountControllerPanes({ terminals: cases.map(([, c]) => c.terminal) });
    try {
      const open = Object.fromEntries(cases.map(([key, c]) => {
        const card = cardIn(host, directoryOf(c));
        return [key, card ? { status: statusRowIn(card)?.textContent?.trim(), painted: paintedStatusIn(card) } : 'no card'];
      }));
      collapse(host, cases);
      const shut = Object.fromEntries(cases.map(([key, c]) => {
        const card = cardIn(host, directoryOf(c));
        return [key, card ? {
          collapsed: collapsed(card, directoryOf(c)),
          label: cardHeaderIn(card, directoryOf(c))?.textContent?.includes(c.text) ?? false,
          painted: paintedStatusIn(card),
        } : 'no card'];
      }));
      const counts = unshownCounts(windowHeaderIn(host)?.textContent ?? '', summaryCounts(cases.map(([, c]) => c)));
      expect.soft(open).toEqual(Object.fromEntries(cases.map(([key, c]) => [key, { status: c.text, painted: { accent: c.statusClass, text: c.statusClass } }])));
      expect.soft(shut).toEqual(Object.fromEntries(cases.map(([key, c]) => [key, { collapsed: true, label: true, painted: { accent: c.statusClass, text: c.statusClass } }])));
      expect.soft(counts).toEqual([]);
    } finally { dispose(); }
  });
});

describe('a collapsed card with a condition', () => {
  it('holds its condition and activity words in its accessible name', () => {
    const { host, dispose } = mountControllerPanes({ terminals: conditionCases.map(([, c]) => c.terminal) });
    try {
      collapse(host, conditionCases);
      const scope = page.elementLocator(host);
      const unnamed = conditionCases.flatMap(([key, c]) => {
        const card = cardIn(host, directoryOf(c));
        if (!collapsed(card, directoryOf(c))) return [`${key}: not shown on a collapsed card`];
        return cardNamedLocator(scope, directoryOf(c), c.text).query() === card ? [] : [`${key}: accessible name lacks "${c.text}"`];
      });
      expect(unnamed).toEqual([]);
    } finally { dispose(); }
  });
});

describe('an activity change alone', () => {
  it('repaints and recounts the card in the update that changes it', () => {
    const gated = (c: StatusCase) => ({ ...c.terminal, id: 'gated', launchDirectory: '/cards/gated', repositoryRoot: '/cards' });
    const [busy, quiet] = [STATUS_CASES['flow-error-and-human-working'], STATUS_CASES['flow-error-and-human']];
    const { host, service, dispose } = mountControllerPanes({ terminals: [gated(busy)] });
    const read = (c: StatusCase) => {
      const card = cardIn(host, '/cards/gated');
      return card ? {
        status: statusRowIn(card)?.textContent?.trim(),
        painted: paintedStatusIn(card),
        countsNotShown: unshownCounts(windowHeaderIn(host)?.textContent ?? '', summaryCounts([c])),
      } : 'no card';
    };
    try {
      const whileWorking = read(busy);
      service.publish([gated(quiet)]);
      const onceIdle = read(quiet);
      service.publish([gated(busy)]);
      const workingAgain = read(busy);
      const shown = (c: StatusCase) => ({ status: c.text, painted: { accent: c.statusClass, text: c.statusClass }, countsNotShown: [] });
      expect({ whileWorking, onceIdle, workingAgain }).toEqual({ whileWorking: shown(busy), onceIdle: shown(quiet), workingAgain: shown(busy) });
    } finally { dispose(); }
  });
});
