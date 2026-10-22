import { expect, it, vi } from 'vitest';
import { createServer, type Socket } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { registerControllerTerminal } from '../../src/main/controllerClient';
import { resolveControllerEndpoint } from '../../src/main/controllerEndpoint';
import { createControllerDecoder, encodeControllerMessage } from '../../src/shared/controllerProtocol';
import type { ControllerWorkStatus } from '../../src/shared/ipc';
import { workStatus } from '../helpers/controllerStatusFixture';

const connections = vi.hoisted(() => [] as Socket[]);
vi.mock('node:net', async importOriginal => {
  const net = await importOriginal<typeof import('node:net')>();
  return { ...net, connect: (...args: Parameters<typeof net.connect>) => {
    const socket = net.connect(...args);
    connections.push(socket);
    return socket;
  } };
});

it('bounds queued writes while a receiver is paused and delivers the latest full status on drain', async () => {
  const root = mkdtempSync(join(tmpdir(), 'at-pressure-'));
  const endpoint = resolveControllerEndpoint(root);
  mkdirSync(dirname(endpoint), { recursive: true });
  let peer: Socket | undefined;
  let publish: ((work: ControllerWorkStatus) => void) | undefined;
  let latest: ControllerWorkStatus | undefined;
  const server = createServer(socket => {
    peer = socket;
    const decoder = createControllerDecoder();
    socket.on('data', (chunk: Buffer) => {
      for (const message of decoder.push(chunk)) {
        if (message.type === 'register') {
          socket.pause();
          socket.write(encodeControllerMessage({ version: 1, type: 'registered' }));
        } else if (message.type === 'status') latest = message.work;
      }
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
    const wireBytes = Buffer.byteLength(encodeControllerMessage({ version: 1, type: 'status', work }));
    for (let index = 0; index < 200; index++) publish!({ ...work, error: { reason: `${work.error!.reason}${index}` } });
    expect(connections.at(-1)!.writableLength).toBeLessThan(wireBytes * 2);
    const current = { ...work, error: { reason: `${work.error!.reason}latest` } };
    publish!(current);
    peer!.resume();
    await expect.poll(() => latest, { timeout: 5000 }).toEqual(current);
  } finally {
    stop();
    peer?.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    connections.length = 0;
    rmSync(root, { recursive: true, force: true });
  }
});
