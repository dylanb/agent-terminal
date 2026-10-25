import { test, expect } from '@playwright/test';
import type WebSocket from 'ws';
import { connectWebSocket, createWebSocketTestServer } from '../helpers/controllerWebSocket';
import { once } from 'node:events';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createControllerHarness } from './controllerHarness';
import { resolveControllerEndpoint } from '../../src/main/controllerEndpoint';
import { STARTUP_CARD } from '../helpers/startupCard';

const controllerTarget = { kind: 'development' as const, entry: resolve('out/main/controller.js') };
const terminalTarget = { kind: 'development' as const, entry: resolve('out/main/index.js') };

test('a terminal speaking a newer minor version registers with the controller and gets a pane', { tag: '@ownapp' }, async () => {
  const h = createControllerHarness();
  let terminal: WebSocket | undefined;
  try {
    const controller = await h.launch(controllerTarget, h.fixture.nonGit);
    await expect(controller.page.getByText(/no terminals/i)).toBeVisible();
    terminal = connectWebSocket(resolveControllerEndpoint(h.fixture.home));
    await once(terminal, 'open');
    let replies = '';
    terminal.on('message', (chunk: Buffer) => { replies += chunk.toString(); });
    terminal.send(`${JSON.stringify({ version: 2, minor: 7, type: 'register', launchDirectory: h.fixture.nonGit, repositoryRoot: null, colour: 'teal' })}`);
    await expect(controller.page.getByRole('button', { name: h.fixture.nonGit, exact: false })).toHaveCount(1);
    await expect.poll(() => replies).toBe('{"version":2,"type":"registered"}');
  } finally {
    terminal?.terminate();
    await h.dispose();
  }
});

for (const { supported, app } of [
  { supported: { min: 1, max: 1 }, app: /update Agent Terminal Controller/i },
  { supported: { min: 3, max: 4 }, app: /update Agent Terminal(?! Controller)/i },
]) {
  test(`a waiting terminal names the app to update when the controller supports versions ${supported.min}–${supported.max}`, { tag: '@ownapp' }, async () => {
    const h = createControllerHarness();
    const sockets = new Set<WebSocket>();
    const endpoint = resolveControllerEndpoint(h.fixture.home);
    mkdirSync(dirname(endpoint), { recursive: true, mode: 0o700 });
    const controller = createWebSocketTestServer(socket => {
      sockets.add(socket);
      socket.on('error', () => socket.terminate());
      socket.once('message', () => socket.send(`${JSON.stringify({ type: 'incompatible', supported })}`));
    });
    try {
      await new Promise<void>(done => controller.listen(endpoint, done));
      const terminal = await h.launch(terminalTarget, h.fixture.nonGit);
      const versionMessage = terminal.page.getByRole('status').filter({ hasNotText: STARTUP_CARD.statusLine });
      await expect(versionMessage).toContainText(app);
      await expect(versionMessage).toContainText(/version/i);
      expect(existsSync(join(h.fixture.root, 'shell-starts'))).toBe(false);
    } finally {
      await h.dispose();
      for (const socket of sockets) socket.terminate();
      await new Promise<void>(done => controller.close(() => done()));
    }
  });
}
