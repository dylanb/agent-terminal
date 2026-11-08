import { expect, test, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import {
  cardHeaderLocator, cardLocator, headerActivationLocator, listSequenceOf, sortOptionLocator, statusRowLocator, windowHeaderLocator,
} from '../helpers/controllerCards';
import { RECENTLY_USED_HEADING } from '../helpers/controllerCardOrderFixture';
import { seedTrustedFlow } from './autoGateHarness';
import { createControllerDesktopHarness } from './controllerDesktop';

const terminalTarget = { kind: 'development' as const, entry: resolve('out/main/index.js') };
const controllerTarget = { kind: 'development' as const, entry: resolve('out/main/controller.js') };
/** A flow no run has started, so a real terminal in its directory reads Unassigned (Idle & unassigned). */
const UNSTARTED_FLOW = 'name: recency\nsteps:\n  - id: implement\n    kind: manual\n';

/** Moves the pointer to the window header and focus out of the cards, so no card is held when the order is read. */
async function away(page: Page): Promise<void> {
  await windowHeaderLocator(page).hover({ position: { x: 4, y: 4 } });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

test('real terminals in Recently used order put the cards whose own controls were pressed first, newest first, and ignore hovering and typing in a terminal window', { tag: '@ownapp' }, async () => {
  test.setTimeout(240_000);
  const h = await createControllerDesktopHarness();
  const [x, y] = h.fixture.repositories;
  const [z] = h.fixture.worktrees;
  try {
    for (const directory of [x, y, z]) seedTrustedFlow(h.fixture.home, directory, 'recency', UNSTARTED_FLOW);
    const { page } = await h.launch(controllerTarget, h.fixture.nonGit);
    const terminals: Record<string, Page> = {};
    for (const directory of [x, y, z]) {
      terminals[directory] = (await h.launch(terminalTarget, directory)).page;
      await expect(statusRowLocator(cardLocator(page, directory))).toHaveText('Unassigned');
    }
    const list = () => listSequenceOf(page, [x, y, z]);

    await sortOptionLocator(page, 'Recently used').click();
    await away(page);
    await expect.soft.poll(list).toEqual([RECENTLY_USED_HEADING, x, y, z]);

    await cardHeaderLocator(cardLocator(page, z), z).click();
    await away(page);
    await expect.soft.poll(list).toEqual([RECENTLY_USED_HEADING, z, x, y]);

    await headerActivationLocator(cardLocator(page, y)).click();
    await away(page);
    await expect.soft.poll(list).toEqual([RECENTLY_USED_HEADING, y, z, x]);

    await cardLocator(page, x).hover();
    await away(page);
    const terminal = terminals[x];
    await terminal.locator('.xterm-screen').click();
    await terminal.keyboard.type("printf 'RECENCY_%s\\n' 'TYPED'");
    await terminal.keyboard.press('Enter');
    await expect(terminal.locator('.xterm-rows')).toContainText('RECENCY_TYPED');
    await expect.soft.poll(list).toEqual([RECENTLY_USED_HEADING, y, z, x]);
  } finally {
    await h.dispose();
  }
});
