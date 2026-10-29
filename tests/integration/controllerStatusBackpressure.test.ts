import WebSocket from 'ws';
import { createWebSocketTestServer } from '../helpers/controllerWebSocket';
import { expect, it } from 'vitest';

import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { registerControllerTerminal } from '../../src/main/controllerClient';
import { resolveControllerEndpoint } from '../../src/main/controllerEndpoint';
import { CONTROLLER_PROTOCOL_MAJOR, parseControllerMessage, encodeControllerMessage } from '../../src/shared/controllerProtocol';
import type { ControllerWorkStatus } from '../../src/shared/ipc';
import { workStatus } from '../helpers/controllerStatusFixture';

it('coalesces a burst for a paused receiver without replaying superseded snapshots', async () => {
  const root = mkdtempSync(join(tmpdir(), 'at-pressure-'));
  const endpoint = resolveControllerEndpoint(root);
  mkdirSync(dirname(endpoint), { recursive: true });
  let peer: WebSocket | undefined;
  let publish: ((work: ControllerWorkStatus) => void) | undefined;
  const received: ControllerWorkStatus[] = [];
  const server = createWebSocketTestServer(socket => {
    peer = socket;
    socket.on('message', (chunk: Buffer) => {
      const message = parseControllerMessage(chunk.toString());
      if (message.type === 'register') {
        socket.pause();
        socket.send(encodeControllerMessage({ version: CONTROLLER_PROTOCOL_MAJOR, type: 'registered' }));
      } else if (message.type === 'status') received.push(message.work);
    });
  });
  await new Promise<void>(resolve => server.listen(endpoint, resolve));
  const stop = registerControllerTerminal(root, { launchDirectory: '/repo', repositoryRoot: '/repo' }, () => 'activated', () => {}, listener => {
    publish = listener;
    return () => { publish = undefined; };
  });
  try {
    await expect.poll(() => publish).toBeTypeOf('function');
    const work = workStatus({ error: { reason: 'x'.repeat(128 * 1024) } });
    publish!(work);
    for (let index = 0; index < 200; index++) publish!({ ...work, error: { reason: `${work.error!.reason}${index}` } });
    const current = { ...work, error: { reason: `${work.error!.reason}latest` } };
    publish!(current);
    peer!.resume();
    await expect.poll(() => received.at(-1), { timeout: 5000 }).toEqual(current);
    expect(received.length).toBeLessThanOrEqual(2);
    expect(received.every(snapshot => snapshot.error?.reason === work.error!.reason || snapshot.error?.reason === current.error.reason)).toBe(true);
  } finally {
    stop();
    peer?.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
