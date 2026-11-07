import { expect, test, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import {
  cardHeaderLocator, cardLocator, headerLabels, listSequenceOf, statusRowLocator, TIME_LABEL_FORMAT, unshownCounts, windowHeaderLocator,
} from '../helpers/controllerCards';
import { seedTrustedFlow } from './autoGateHarness';
import { createControllerDesktopHarness } from './controllerDesktop';
import { connectedTerminals } from './controllerSnapshot';

const terminalTarget = { kind: 'development' as const, entry: resolve('out/main/index.js') };
const controllerTarget = { kind: 'development' as const, entry: resolve('out/main/controller.js') };
/** A flow no run has started, so a real terminal in its repository reads Unassigned (Idle & unassigned), not Flow error. */
const UNSTARTED_FLOW = 'name: attention-order\nsteps:\n  - id: implement\n    kind: manual\n';

const headerCountsNotShown = async (page: Page, counts: Record<string, number>, total: number, connected: number) =>
  unshownCounts((await windowHeaderLocator(page).allTextContents()).join(' '), headerLabels(label => counts[label] ?? 0, total, connected));
const headerStatusOf = (page: Page, directory: string) => cardHeaderLocator(cardLocator(page, directory), directory).innerText()
  .then(text => text.replace(/\s+/g, ' ').trim());

test('real terminals sort under Attention-order group headings, a card that changes group joining its new group after the card already there', { tag: '@ownapp' }, async () => {
  test.setTimeout(240_000);
  const h = await createControllerDesktopHarness();
  const [x, y] = h.fixture.repositories;
  try {
    for (const repo of [x, y]) seedTrustedFlow(h.fixture.home, repo, 'attention-order', UNSTARTED_FLOW);
    const { page } = await h.launch(controllerTarget, h.fixture.nonGit);
    await h.launch(terminalTarget, x);
    await expect(cardLocator(page, x)).toBeVisible();
    const b = await h.launch(terminalTarget, y);
    await expect(cardLocator(page, y)).toBeVisible();
    await expect.soft.poll(() => listSequenceOf(page, [x, y])).toEqual(['Idle & unassigned 2', x, y]);

    await h.launch(terminalTarget, x);
    await expect.poll(() => connectedTerminals(page, x).then(items => items.length)).toBe(2);
    await expect(statusRowLocator(cardLocator(page, x))).toContainText('Duplicate directory');
    await expect.soft.poll(() => listSequenceOf(page, [x, y])).toEqual(['Errors 1', x, 'Idle & unassigned 1', y]);

    await b.app.close();
    await expect(statusRowLocator(cardLocator(page, y))).toHaveText('Disconnected');
    await expect.soft.poll(() => listSequenceOf(page, [x, y])).toEqual(['Errors 2', x, y]);
    expect.soft(await headerCountsNotShown(page, { errors: 2 }, 2, 1)).toEqual([]);
    for (const directory of [x, y]) {
      expect.soft(await headerStatusOf(page, directory)).toMatch(TIME_LABEL_FORMAT);
    }
  } finally {
    await h.dispose();
  }
});
