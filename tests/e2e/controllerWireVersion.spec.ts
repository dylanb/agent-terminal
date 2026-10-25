import { test, expect } from '@playwright/test';
import { connect, createServer, type Socket } from 'node:net';
import { once } from 'node:events';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createControllerHarness } from './controllerHarness';
import { resolveControllerEndpoint } from '../../src/main/controllerEndpoint';
import { STARTUP_CARD, STARTUP_CARD_READING_ORDER } from '../helpers/startupCard';
import { exposedText, nodesWithRole, parseAriaSnapshot, wholeText } from '../helpers/ariaSnapshot';

const controllerTarget = { kind: 'development' as const, entry: resolve('out/main/controller.js') };
const terminalTarget = { kind: 'development' as const, entry: resolve('out/main/index.js') };
const squash = (text: string) => text.replace(/\s+/g, '');

test('a terminal speaking a newer minor version registers with the controller and gets a pane', { tag: '@ownapp' }, async () => {
  const h = createControllerHarness();
  let terminal: Socket | undefined;
  try {
    const controller = await h.launch(controllerTarget, h.fixture.nonGit);
    await expect(controller.page.getByText(/no terminals/i)).toBeVisible();
    terminal = connect(resolveControllerEndpoint(h.fixture.home));
    await once(terminal, 'connect');
    let replies = '';
    terminal.on('data', (chunk: Buffer) => { replies += chunk.toString(); });
    terminal.write(`${JSON.stringify({ version: 1, minor: 7, type: 'register', launchDirectory: h.fixture.nonGit, repositoryRoot: null, colour: 'teal' })}\n`);
    await expect(controller.page.getByRole('button', { name: h.fixture.nonGit, exact: false })).toHaveCount(1);
    await expect.poll(() => replies).toBe('{"version":1,"type":"registered"}\n');
  } finally {
    terminal?.destroy();
    await h.dispose();
  }
});

for (const { supported, app } of [
  { supported: { min: 0, max: 0 }, app: /update Agent Terminal Controller/i },
  { supported: { min: 2, max: 3 }, app: /update Agent Terminal(?! Controller)/i },
]) {
  test(`a waiting terminal names the app to update when the controller supports versions ${supported.min}–${supported.max}`, { tag: '@ownapp' }, async () => {
    const h = createControllerHarness();
    const sockets = new Set<Socket>();
    const endpoint = resolveControllerEndpoint(h.fixture.home);
    mkdirSync(dirname(endpoint), { recursive: true, mode: 0o700 });
    const controller = createServer(socket => {
      sockets.add(socket);
      socket.on('error', () => socket.destroy());
      socket.once('data', () => socket.end(`${JSON.stringify({ type: 'incompatible', supported })}\n`));
    });
    try {
      await new Promise<void>(done => controller.listen(endpoint, done));
      const terminal = await h.launch(terminalTarget, h.fixture.nonGit);
      const card = async () => parseAriaSnapshot(await terminal.page.locator('body').ariaSnapshot());
      const versionRegions = async () => nodesWithRole(await card(), 'status').map(wholeText).filter(text => !text.includes(STARTUP_CARD.statusLine));
      await expect.poll(versionRegions).toEqual([expect.stringMatching(app)]);
      const [message] = await versionRegions();
      expect.soft(message).toMatch(/version/i);
      expect.soft(STARTUP_CARD_READING_ORDER.filter(text => message.includes(text))).toEqual([]);
      const read = exposedText(await card());
      const expected = [...STARTUP_CARD_READING_ORDER.slice(0, -1), message, STARTUP_CARD.statusLine];
      expect.soft(squash(read.join(''))).toBe(squash(expected.join('')));
      expect(existsSync(join(h.fixture.root, 'shell-starts'))).toBe(false);
    } finally {
      await h.dispose();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(done => controller.close(() => done()));
    }
  });
}
