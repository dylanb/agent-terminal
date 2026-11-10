import { test, expect } from '@playwright/test';
import { basename, resolve, join } from 'node:path';
import { createControllerHarness } from './controllerHarness';
import { createControllerRegistrationRelay } from './controllerRegistrationRelay';
import { cardLocator, statusRowLocator } from '../helpers/controllerCards';

const controllerTarget = { kind: 'development' as const, entry: resolve('out/main/controller.js') };
const terminalTarget = { kind: 'development' as const, entry: resolve('out/main/index.js') };
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

for (const loss of ['shell exit', 'terminal crash', 'connection loss'] as const) {
  test(`last pane retains identifying disconnected error after ${loss}`, { tag: '@ownapp' }, async () => {
    const h = createControllerHarness();
    h.fixture.env.APP_STARTUP_EXIT_GRACE_MS = '1';
    let relayDisposed = false;
    const controllerHome = loss === 'connection loss' ? join(h.fixture.root, 'controller-state') : h.fixture.home;
    const relay = loss === 'connection loss' ? await createControllerRegistrationRelay(h.fixture.home, controllerHome) : undefined;
    try {
      h.fixture.env.APP_HOME_DIR = controllerHome;
      const controller = await h.launch(controllerTarget, h.fixture.nonGit);
      h.fixture.env.APP_HOME_DIR = h.fixture.home;
      const directory = h.fixture.worktrees[0];
      const terminal = await h.launch(terminalTarget, directory);
      await expect(cardLocator(controller.page, directory)).toHaveCount(1);
      await terminal.page.locator('.xterm-screen').click();
      await terminal.page.keyboard.type("printf 'RETENTION_%s\\n' 'READY'");
      await terminal.page.keyboard.press('Enter');
      await expect(terminal.page.locator('.xterm-rows')).toContainText('RETENTION_READY');
      if (loss === 'shell exit') {
        const closed = terminal.page.waitForEvent('close');
        await terminal.page.keyboard.type('exit');
        await terminal.page.keyboard.press('Enter').catch(error => {
          if (!terminal.page.isClosed()) throw error;
        });
        await closed;
      } else if (loss === 'terminal crash') await h.crash(terminal.app);
      else { await relay!.dispose(); relayDisposed = true; }
      await expect.soft(statusRowLocator(cardLocator(controller.page, directory))).toHaveText('Disconnected');
      await expect.soft(controller.page.locator('body')).toContainText(directory);
      await expect.soft(cardLocator(controller.page, directory)).toHaveAccessibleName(new RegExp(`${escapeRegExp(basename(directory))}\\s[\\s\\S]*${escapeRegExp(directory)}`));
      await expect.soft(controller.page.locator('body')).not.toContainText(/no terminals (?:are )?connected/i);
    } finally {
      try { await h.dispose(); }
      finally { if (!relayDisposed) await relay?.dispose(); }
    }
  });
}
