import { expect, test, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { createControllerHarness } from './controllerHarness';
import { EXISTING_TOKEN_NAMES, STATUS_TOKEN_NAMES, expectedColor, type DesignToken, type Theme } from '../helpers/designTokens';
import { mismatchedTokens, paintColors, paintTokens } from '../helpers/tokenProbe';

async function offTable(page: Page, names: readonly DesignToken[]): Promise<string[]> {
  const theme: Theme = (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark' ? 'dark' : 'light';
  const painted = await page.evaluate(paintTokens, names);
  const expected = await page.evaluate(paintColors, names.map((name) => expectedColor(name, theme)));
  return mismatchedTokens(names, painted, expected);
}

test('the controller and agent-terminal windows both resolve every design token', { tag: '@ownapp' }, async () => {
  const h = createControllerHarness();
  try {
    const controller = await h.launch({ kind: 'development', entry: resolve('out/main/controller.js') }, h.fixture.nonGit);
    const terminal = await h.launch({ kind: 'development', entry: resolve('out/main/index.js') }, h.fixture.repositories[0]);
    await controller.page.waitForLoadState('load');
    await terminal.page.waitForLoadState('load');
    expect.soft(await offTable(controller.page, EXISTING_TOKEN_NAMES)).toEqual([]);
    expect.soft(await offTable(controller.page, STATUS_TOKEN_NAMES)).toEqual([]);
    expect.soft(await offTable(terminal.page, EXISTING_TOKEN_NAMES)).toEqual([]);
    expect.soft(await offTable(terminal.page, STATUS_TOKEN_NAMES)).toEqual([]);
  } finally {
    await h.dispose();
  }
});
