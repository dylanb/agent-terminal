import { test, expect } from '@playwright/test';
import { resolve, join } from 'node:path';
import { createControllerHarness } from './controllerHarness';
import { createControllerRegistrationRelay } from './controllerRegistrationRelay';
import { cardLocator, dismissLocator, statusRowLocator } from '../helpers/controllerCards';

const controllerTarget = { kind: 'development' as const, entry: resolve('out/main/controller.js') };
const terminalTarget = { kind: 'development' as const, entry: resolve('out/main/index.js') };

test('dismiss last retained pane to guidance and accept a subsequent terminal', { tag: '@ownapp' }, async () => {
  const h = createControllerHarness();
  try {
    const controller = await h.launch(controllerTarget, h.fixture.nonGit);
    const directory = h.fixture.worktrees[0];
    const terminal = await h.launch(terminalTarget, directory);
    await expect(cardLocator(controller.page, directory)).toHaveCount(1);
    await h.crash(terminal.app);
    await expect(statusRowLocator(cardLocator(controller.page, directory))).toHaveText('Disconnected');
    const dismiss = dismissLocator(cardLocator(controller.page, directory));
    await expect(dismiss).toBeVisible();
    await dismiss.click();
    await expect.soft(controller.page.locator('body')).not.toContainText(directory);
    await expect.soft(controller.page.locator('body')).toContainText(/no terminals connected.*launch.*terminal/i);
    const next = await h.launch(terminalTarget, h.fixture.worktrees[1]);
    await expect.soft(cardLocator(controller.page, h.fixture.worktrees[1])).toHaveCount(1);
    await next.page.locator('.xterm-screen').click();
    await next.page.keyboard.type("printf 'DISMISS_%s\\n' 'CONTINUED'");
    await next.page.keyboard.press('Enter');
    await expect(next.page.locator('.xterm-rows')).toContainText('DISMISS_CONTINUED');
  } finally { await h.dispose(); }
});

test('new terminal replaces stale same-directory panes and preserves live peers and other directories', { tag: '@ownapp' }, async () => {
  const h = createControllerHarness();
  try {
    const controller = await h.launch(controllerTarget, h.fixture.nonGit);
    const directory = h.fixture.worktrees[0];
    const stale = await h.launch(terminalTarget, directory);
    const live = await h.launch(terminalTarget, directory);
    const other = await h.launch(terminalTarget, h.fixture.worktrees[1]);
    await expect(cardLocator(controller.page, directory)).toHaveCount(2);
    await expect(cardLocator(controller.page, h.fixture.worktrees[1])).toHaveCount(1);
    await h.crash(stale.app);
    await h.crash(other.app);
    await expect(statusRowLocator(controller.page).filter({ hasText: /^Disconnected$/ })).toHaveCount(2);
    const replacement = await h.launch(terminalTarget, directory);
    await expect(cardLocator(controller.page, directory)).toHaveCount(2);
    await expect.soft(statusRowLocator(controller.page).filter({ hasText: /^Disconnected$/ })).toHaveCount(1);
    await expect.soft(statusRowLocator(cardLocator(controller.page, h.fixture.worktrees[1]))).toHaveText('Disconnected');
    for (const [index, target] of [live, replacement].entries()) {
      await target.page.locator('.xterm-screen').click();
      await target.page.keyboard.type(`printf 'REPLACE_${index}_%s\\n' 'ALIVE'`);
      await target.page.keyboard.press('Enter');
      await expect(target.page.locator('.xterm-rows')).toContainText(`REPLACE_${index}_ALIVE`);
    }
  } finally { await h.dispose(); }
});

test('same terminal reconnects after dismissal without restarting its PTY', { tag: '@ownapp' }, async () => {
  const h = createControllerHarness();
  const controllerHome = join(h.fixture.root, 'controller-state');
  let relay = await createControllerRegistrationRelay(h.fixture.home, controllerHome);
  let relayDisposed = false;
  try {
    h.fixture.env.APP_HOME_DIR = controllerHome;
    const controller = await h.launch(controllerTarget, h.fixture.nonGit);
    h.fixture.env.APP_HOME_DIR = h.fixture.home;
    const directory = h.fixture.worktrees[0];
    const terminal = await h.launch(terminalTarget, directory);
    await expect(cardLocator(controller.page, directory)).toHaveCount(1);
    await terminal.page.locator('.xterm-screen').click();
    await terminal.page.keyboard.type('DISMISS_SESSION=original');
    await terminal.page.keyboard.press('Enter');
    await relay.dispose();
    relayDisposed = true;
    await expect(statusRowLocator(cardLocator(controller.page, directory))).toHaveText('Disconnected');
    const dismiss = dismissLocator(cardLocator(controller.page, directory));
    await expect(dismiss).toBeVisible();
    await dismiss.click();
    await expect.soft(controller.page.locator('body')).toContainText(/no terminals connected/i);
    relay = await createControllerRegistrationRelay(h.fixture.home, controllerHome);
    relayDisposed = false;
    await expect(cardLocator(controller.page, directory)).toHaveCount(1, { timeout: 10_000 });
    await expect.soft(statusRowLocator(cardLocator(controller.page, directory))).not.toHaveText('Disconnected');
    await terminal.page.locator('.xterm-screen').click();
    await terminal.page.keyboard.type('printf "SESSION_%s\\n" "$DISMISS_SESSION"');
    await terminal.page.keyboard.press('Enter');
    await expect(terminal.page.locator('.xterm-rows')).toContainText('SESSION_original');
  } finally {
    try { await h.dispose(); }
    finally { if (!relayDisposed) await relay.dispose(); }
  }
});

test('same terminal repeated reconnection replaces its retained pane', { tag: '@ownapp' }, async () => {
  const h = createControllerHarness();
  const controllerHome = join(h.fixture.root, 'controller-state');
  const relay = await createControllerRegistrationRelay(h.fixture.home, controllerHome);
  try {
    h.fixture.env.APP_HOME_DIR = controllerHome;
    const controller = await h.launch(controllerTarget, h.fixture.nonGit);
    h.fixture.env.APP_HOME_DIR = h.fixture.home;
    const directory = h.fixture.worktrees[0];
    await h.launch(terminalTarget, directory);
    await expect(cardLocator(controller.page, directory)).toHaveCount(1);
    for (let round = 0; round < 2; round++) {
      await relay.replayRegistrations();
      await expect.soft(statusRowLocator(cardLocator(controller.page, directory))).not.toHaveText('Disconnected');
      await expect.soft(cardLocator(controller.page, directory)).toHaveCount(1);
    }
  } finally {
    try { await h.dispose(); }
    finally { await relay.dispose(); }
  }
});
