import { waitForConnections } from './controllerSnapshot';
import { test, expect } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { connect, createServer, type Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { createControllerDesktopHarness } from './controllerDesktop';
import { typeAtDesktop } from './controllerKeyboard';
import { createControllerRegistrationRelay } from './controllerRegistrationRelay';
import { shellQuote } from '../../src/shared/shellQuote';
import { resolveControllerEndpoint } from '../../src/main/controllerEndpoint';
import { bringForwardLocator, cardLocator } from '../helpers/controllerCards';

const terminalTarget = { kind: 'development' as const, entry: resolve('out/main/index.js') };
const controllerTarget = { kind: 'development' as const, entry: resolve('out/main/controller.js') };
const RECOVERY_BOUND_MS = 10_000;

test('connection-only loss preserves PTY work and restores one pane while the controller remains running', { tag: '@ownapp' }, async () => {
  const h = await createControllerDesktopHarness();
  const sockets = new Set<Socket>();
  const controllerHome = join(h.fixture.root, 'controller-state');
  const endpoint = resolveControllerEndpoint(h.fixture.home);
  mkdirSync(dirname(endpoint), { recursive: true, mode: 0o700 });
  const relay = createServer(downstream => {
    const upstream = connect(resolveControllerEndpoint(controllerHome));
    for (const socket of [downstream, upstream]) {
      sockets.add(socket);
      socket.on('error', () => socket.destroy());
      socket.on('close', () => { sockets.delete(socket); downstream.destroy(); upstream.destroy(); });
    }
    downstream.pipe(upstream).pipe(downstream);
  });
  try {
    await new Promise<void>(resolve => relay.listen(endpoint, resolve));
    h.fixture.env.APP_HOME_DIR = controllerHome;
    const controller = await h.launch(controllerTarget, h.fixture.nonGit);
    h.fixture.env.APP_HOME_DIR = h.fixture.home;
    const terminal = await h.launch(terminalTarget, h.fixture.nonGit);
    const pane = cardLocator(controller.page, h.fixture.nonGit);
    await expect(pane).toHaveCount(1);
    await terminal.page.locator('.xterm-screen').click();
    await terminal.page.keyboard.type('export SURVIVING_WORK=original; printf "BEFORE_%s\\n" "$SURVIVING_WORK"');
    await terminal.page.keyboard.press('Enter');
    await expect(terminal.page.locator('.xterm-rows')).toContainText('BEFORE_original');
    for (let round = 0; round < 2; round++) {
      for (const socket of sockets) socket.destroy();
      await terminal.page.keyboard.type(`printf 'AFTER_${round}_%s\\n' "$SURVIVING_WORK"`);
      await terminal.page.keyboard.press('Enter');
      await expect.soft(terminal.page.locator('.xterm-rows')).toContainText(`AFTER_${round}_original`);
      await delay(RECOVERY_BOUND_MS);
      expect.soft(controller.app.process().exitCode).toBeNull();
      await expect.soft(bringForwardLocator(pane)).toHaveCount(1);
      expect.soft(readFileSync(join(h.fixture.root, 'shell-starts'), 'utf8')).toBe('started\n');
    }
  } finally {
    try { await h.dispose(); }
    finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => relay.close(() => resolve()));
    }
  }
});

for (const outage of ['quit', 'crash'] as const) {
  test(`recovery restores original PTYs and fixed identities after repeated controller ${outage}`, { tag: '@ownapp' }, async () => {
    test.setTimeout(180_000);
    const h = await createControllerDesktopHarness();
    try {
      let controller = await h.launch(controllerTarget, h.fixture.nonGit);
      const directory = h.fixture.worktrees[0];
      const terminals: Array<Awaited<ReturnType<typeof h.launch>>> = [];
      for (let index = 0; index < 2; index++) {
        const terminal = await h.launch(terminalTarget, directory);
        terminals.push(terminal);
        await terminal.page.locator('.xterm-screen').click();
        await terminal.page.keyboard.type(`export ORIGINAL_PEER=${index}; cd ${shellQuote(h.fixture.nonGit)}; printf 'ORIGINAL_%s\\n' "$ORIGINAL_PEER"`);
        await terminal.page.keyboard.press('Enter');
        await expect(terminal.page.locator('.xterm-rows')).toContainText(`ORIGINAL_${index}`);
      }
      await waitForConnections(controller.page, directory, 2);
      await expect.soft(cardLocator(controller.page, directory)).toHaveCount(1);
      for (let round = 0; round < 2; round++) {
        if (outage === 'quit') await controller.app.close();
        else await h.crash(controller.app);
        for (const [index, terminal] of terminals.entries()) {
          await terminal.page.locator('.xterm-screen').click();
          await terminal.page.keyboard.type(`printf 'OUTAGE_${round}_%s\\n' "$ORIGINAL_PEER"`);
          await terminal.page.keyboard.press('Enter');
          await expect.soft(terminal.page.locator('.xterm-rows')).toContainText(`OUTAGE_${round}_${index}`);
        }
        controller = await h.launch(controllerTarget, h.fixture.nonGit);
        await waitForConnections(controller.page, directory, 2);
        await expect.soft(cardLocator(controller.page, directory)).toHaveCount(1);
        await expect.soft(cardLocator(controller.page, h.fixture.nonGit)).toHaveCount(0);
        expect.soft(readFileSync(join(h.fixture.root, 'shell-starts'), 'utf8')).toBe('started\nstarted\n');
      }
    } finally { await h.dispose(); }
  });
}

for (const mode of ['direct', 'replay', 'reconnect'] as const) {
  const restart = mode !== 'direct';
  test(mode === 'reconnect'
    ? 'automatic reconnection after controller crash routes to both original same-directory PTYs'
    : restart
    ? 'replayed registration after controller restart routes to both original same-directory terminals'
    : 'same-directory panes restore and route desktop keyboard input to both original terminals', { tag: '@ownapp' }, async () => {
  test.setTimeout(120_000);
  const h = await createControllerDesktopHarness();
  const controllerHome = mode === 'replay' ? join(h.fixture.root, 'routing-controller') : h.fixture.home;
  const relay = mode === 'replay' ? await createControllerRegistrationRelay(h.fixture.home, controllerHome) : undefined;
  try {
    h.fixture.env.APP_HOME_DIR = controllerHome;
    let controller = await h.launch(controllerTarget, h.fixture.nonGit);
    h.fixture.env.APP_HOME_DIR = h.fixture.home;
    const terminals: Array<Awaited<ReturnType<typeof h.launch>>> = [];
    for (let index = 0; index < 2; index++) {
      const terminal = await h.launch(terminalTarget, h.fixture.repositories[0]);
      terminals.push(terminal);
      await terminal.page.locator('.xterm-screen').click();
      await terminal.page.keyboard.type(`export ORIGINAL_PEER=${index}; printf 'READY_%s\\n' "$ORIGINAL_PEER"`);
      await terminal.page.keyboard.press('Enter');
      await expect(terminal.page.locator('.xterm-rows')).toContainText(`READY_${index}`);
      await terminal.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
      await expect.poll(() => terminal.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized())).toBe(true);
    }
    if (restart) {
      await h.crash(controller.app);
      h.fixture.env.APP_HOME_DIR = controllerHome;
      controller = await h.launch(controllerTarget, h.fixture.nonGit);
      h.fixture.env.APP_HOME_DIR = h.fixture.home;
      await relay?.replayRegistrations();
    }
    const panes = cardLocator(controller.page, h.fixture.repositories[0]);
    await waitForConnections(controller.page, h.fixture.repositories[0], 2);
    await expect.soft(panes).toHaveCount(1);
    await controller.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus());
    await bringForwardLocator(panes.first()).click();
    await expect.soft.poll(async () => Promise.all(terminals.map(terminal => terminal.app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      return window.isVisible() && !window.isMinimized();
    })))).toEqual([true, true]);
    for (const [index, terminal] of terminals.entries()) {
      await terminal.app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.restore(); window.show(); window.focus(); });
      await expect.poll(() => terminal.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused())).toBe(true);
      typeAtDesktop(`printf 'RECOVERED_${index}_%s\\n' "$ORIGINAL_PEER"`, h.fixture.env);
      await expect.soft(terminal.page.locator('.xterm-rows')).toContainText(`RECOVERED_${index}_${index}`);
    }
    await expect.soft(panes).toHaveCount(1);
    expect(readFileSync(join(h.fixture.root, 'shell-starts'), 'utf8')).toBe('started\nstarted\n');
  } finally {
    try { await h.dispose(); }
    finally { await relay?.dispose(); }
  }
});
}
