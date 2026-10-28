import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import { createControllerDesktopHarness } from './controllerDesktop';
import { isAlwaysOnTop } from './controllerWindow';
import { alwaysOnTopLocator } from '../helpers/controllerCards';

const controllerTarget = { kind: 'development' as const, entry: resolve('out/main/controller.js') };

test('a new profile starts with the controller always on top, shown on the header switch', { tag: '@ownapp' }, async () => {
  const h = await createControllerDesktopHarness();
  try {
    const { app, page } = await h.launch(controllerTarget, h.fixture.nonGit);
    await expect.soft(alwaysOnTopLocator(page)).toHaveAttribute('aria-checked', 'true');
    await expect.soft.poll(() => isAlwaysOnTop(app)).toBe(true);
  } finally {
    await h.dispose();
  }
});

test('the header Always on top switch toggles by pointer, Space and Enter, and the window follows each toggle', { tag: '@ownapp' }, async () => {
  test.setTimeout(120_000);
  const h = await createControllerDesktopHarness();
  try {
    const { app, page } = await h.launch(controllerTarget, h.fixture.nonGit);
    const control = alwaysOnTopLocator(page);
    /** Each toggle acts only on a switch the check before it has waited for, so a missing switch leaves every check to report. */
    const toggle = async (act: () => Promise<void>) => { if (await control.isVisible()) await act(); };
    const press = (key: string) => async () => { await control.focus(); await page.keyboard.press(key); };
    await expect.soft(control).toHaveAttribute('aria-checked', 'true');

    await toggle(() => control.click());
    await expect.soft(control).toHaveAttribute('aria-checked', 'false');
    await expect.soft.poll(() => isAlwaysOnTop(app)).toBe(false);

    await toggle(press('Space'));
    await expect.soft(control).toHaveAttribute('aria-checked', 'true');
    await expect.soft.poll(() => isAlwaysOnTop(app)).toBe(true);

    await toggle(press('Enter'));
    await expect.soft(control).toHaveAttribute('aria-checked', 'false');
    await expect.soft.poll(() => isAlwaysOnTop(app)).toBe(false);
  } finally {
    await h.dispose();
  }
});
