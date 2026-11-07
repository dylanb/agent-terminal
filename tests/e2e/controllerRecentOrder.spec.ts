import { expect, test, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { cardLocator, listSequenceOf, sortOptionLocator, statusRowLocator, type SortOption } from '../helpers/controllerCards';
import { RECENTLY_USED_HEADING, SORT_SENTENCES } from '../helpers/controllerCardOrderFixture';
import { SORT_MODES, type SortMode } from '../helpers/controllerStatusFixture';
import { seedTrustedFlow } from './autoGateHarness';
import { createControllerDesktopHarness } from './controllerDesktop';
import { connectedTerminals } from './controllerSnapshot';

const terminalTarget = { kind: 'development' as const, entry: resolve('out/main/index.js') };
const controllerTarget = { kind: 'development' as const, entry: resolve('out/main/controller.js') };
/** A flow no run has started, so a real terminal in its repository reads Unassigned (Idle & unassigned), not Flow error. */
const UNSTARTED_FLOW = 'name: recent-order\nsteps:\n  - id: implement\n    kind: manual\n';

/** What the window shows of the order: the list, the selected option, and which order sentences it shows. */
const orderShown = async (page: Page, directories: readonly string[]) => {
  const text = await page.locator('body').innerText();
  const selected = [];
  for (const option of ['Attention', 'Recently used'] as const satisfies readonly SortOption[]) {
    if (await sortOptionLocator(page, option, { selected: true }).count()) selected.push(option);
  }
  return {
    list: await listSequenceOf(page, directories),
    selected,
    sentences: SORT_MODES.filter((mode: SortMode) => text.includes(SORT_SENTENCES[mode])),
  };
};

test('real terminals re-sort to one Recently used heading in Attention order and back, by pointer and by keyboard, the sentence and selection following', { tag: '@ownapp' }, async () => {
  test.setTimeout(240_000);
  const h = await createControllerDesktopHarness();
  const [x, y] = h.fixture.repositories;
  try {
    for (const repo of [x, y]) seedTrustedFlow(h.fixture.home, repo, 'recent-order', UNSTARTED_FLOW);
    const { page } = await h.launch(controllerTarget, h.fixture.nonGit);
    await h.launch(terminalTarget, x);
    await expect(cardLocator(page, x)).toBeVisible();
    await h.launch(terminalTarget, y);
    await expect(cardLocator(page, y)).toBeVisible();
    await h.launch(terminalTarget, y);
    await expect.poll(() => connectedTerminals(page, y).then(items => items.length)).toBe(2);
    await expect(statusRowLocator(cardLocator(page, y))).toContainText('Duplicate directory');

    const attention = { list: ['Errors 1', y, 'Idle & unassigned 1', x], selected: ['Attention'], sentences: ['attention'] };
    const recent = { list: [RECENTLY_USED_HEADING, y, x], selected: ['Recently used'], sentences: ['recently-used'] };
    await expect.soft.poll(() => orderShown(page, [x, y])).toEqual(attention);

    await sortOptionLocator(page, 'Recently used').click();
    await expect.soft.poll(() => orderShown(page, [x, y])).toEqual(recent);

    await sortOptionLocator(page, 'Recently used').focus();
    await page.keyboard.press('ArrowLeft');
    await expect.soft.poll(() => orderShown(page, [x, y])).toEqual(attention);

    await sortOptionLocator(page, 'Attention').focus();
    await page.keyboard.press('ArrowRight');
    await expect.soft.poll(() => orderShown(page, [x, y])).toEqual(recent);
  } finally {
    await h.dispose();
  }
});
