import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import {
  cardHeaderLocator, cardLocator, headerActivationLocator, headerLabels, listSequenceOf, POSITION_HELD, sortOptionLocator, statusRowLocator,
  TIME_LABEL_FORMAT, unshownCounts, windowHeaderLocator,
} from '../helpers/controllerCards';
import { RECENTLY_USED_HEADING, SORT_SENTENCES } from '../helpers/controllerCardOrderFixture';
import { createControllerSettingsStore } from '../../src/main/controllerSettings';
import { seedTrustedFlow } from './autoGateHarness';
import { createControllerDesktopHarness } from './controllerDesktop';
import { waitForConnections } from './controllerSnapshot';

const terminalTarget = { kind: 'development' as const, entry: resolve('out/main/index.js') };
const controllerTarget = { kind: 'development' as const, entry: resolve('out/main/controller.js') };
/** A flow no run has started, so a real terminal in its directory reads Unassigned (Idle & unassigned). */
const UNSTARTED_FLOW = 'name: hold\nsteps:\n  - id: implement\n    kind: manual\n';

const headerStatusOf = (page: Page, directory: string) => cardHeaderLocator(cardLocator(page, directory), directory).innerText()
  .then(text => text.replace(/\s+/g, ' ').trim());
const headerCountsNotShown = async (page: Page, counts: Record<string, number>, total: number, connected: number) =>
  unshownCounts((await windowHeaderLocator(page).allTextContents()).join(' '), headerLabels(label => counts[label] ?? 0, total, connected));
const focused = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused());

/** Playwright emulates page focus, so without this the controller page reports focus and gets no `blur` while another
 *  window has it. */
async function useRealWindowFocus(app: ElectronApplication, page: Page): Promise<void> {
  const session = await app.context().newCDPSession(page);
  await session.send('Emulation.setFocusEmulationEnabled', { enabled: false });
}

/** Moves the pointer to the window header and focus out of the cards, so no card is held. */
async function away(page: Page): Promise<void> {
  await windowHeaderLocator(page).hover({ position: { x: 4, y: 4 } });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

test('tracer: a card under the pointer or with focus holds the list in place through a real status change and a sort-mode change, and the list re-sorts when the hold ends', { tag: '@ownapp' }, async () => {
  test.setTimeout(300_000);
  const h = await createControllerDesktopHarness();
  const [x, y] = h.fixture.repositories;
  const [z] = h.fixture.worktrees;
  try {
    for (const directory of [x, y, z]) seedTrustedFlow(h.fixture.home, directory, 'hold', UNSTARTED_FLOW);
    const controller = await h.launch(controllerTarget, h.fixture.nonGit);
    const { page } = controller;
    const xTerminal = await h.launch(terminalTarget, x);
    await expect(statusRowLocator(cardLocator(page, x))).toHaveText('Unassigned');
    const yTerminal = await h.launch(terminalTarget, y);
    await expect(statusRowLocator(cardLocator(page, y))).toHaveText('Unassigned');
    await h.launch(terminalTarget, z);
    await expect(statusRowLocator(cardLocator(page, z))).toHaveText('Unassigned');
    const duplicate = await h.launch(terminalTarget, x);
    await waitForConnections(page, x, 2);
    await expect(statusRowLocator(cardLocator(page, x))).toContainText('Duplicate directory');
    await yTerminal.app.close();
    await expect(statusRowLocator(cardLocator(page, y))).toHaveText('Disconnected');
    const list = () => listSequenceOf(page, [x, y, z]);
    await away(page);
    await expect.soft.poll(list).toEqual(['Errors 2', x, y, 'Idle & unassigned 1', z]);

    await cardLocator(page, x).hover();
    await duplicate.app.close();
    await waitForConnections(page, x, 1);
    await expect(statusRowLocator(cardLocator(page, x))).toHaveText('Unassigned');
    await expect.soft.poll(list).toEqual(['Errors 1', x, y, 'Idle & unassigned 2', z]);
    expect.soft(await headerStatusOf(page, x)).toMatch(new RegExp(`Unassigned${TIME_LABEL_FORMAT.source}`));
    await expect.soft.poll(() => headerStatusOf(page, x)).toMatch(POSITION_HELD);
    expect.soft(await headerCountsNotShown(page, { errors: 1, idle: 2 }, 3, 2)).toEqual([]);

    await away(page);
    await expect.soft.poll(list).toEqual(['Errors 1', y, 'Idle & unassigned 2', z, x]);
    expect.soft(await headerStatusOf(page, x)).not.toMatch(POSITION_HELD);

    await cardHeaderLocator(cardLocator(page, z), z).click();
    await away(page);
    await cardLocator(page, y).hover();
    await sortOptionLocator(page, 'Attention').focus();
    await page.keyboard.press('ArrowRight');
    await expect.soft(sortOptionLocator(page, 'Recently used', { selected: true })).toBeVisible();
    await expect.soft(page.getByText(SORT_SENTENCES['recently-used'], { exact: true })).toBeVisible();
    await expect.soft.poll(list).toEqual(['Errors 1', y, 'Idle & unassigned 2', z, x]);
    await away(page);
    await expect.soft.poll(list).toEqual([RECENTLY_USED_HEADING, z, y, x]);

    await useRealWindowFocus(controller.app, page);
    await controller.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus());
    await expect.poll(() => focused(controller.app)).toBe(true);
    await headerActivationLocator(cardLocator(page, x)).focus();
    await expect.soft.poll(() => headerStatusOf(page, x)).toMatch(POSITION_HELD);
    await page.keyboard.press('Enter');
    await expect.soft.poll(() => focused(xTerminal.app)).toBe(true);
    await expect.soft.poll(list).toEqual([RECENTLY_USED_HEADING, x, z, y]);
    expect.soft(await headerStatusOf(page, x)).not.toMatch(POSITION_HELD);

    await expect.poll(() => createControllerSettingsStore(controller.profile).sortMode()).toBe('recently-used').catch(() => undefined);
    await controller.app.close();
    const restarted = await h.launch(controllerTarget, h.fixture.nonGit, { profile: controller.profile });
    await expect.soft(sortOptionLocator(restarted.page, 'Recently used', { selected: true })).toBeVisible();
  } finally {
    await h.dispose();
  }
});
