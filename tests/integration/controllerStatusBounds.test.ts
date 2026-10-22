import { expect, it } from 'vitest';
import { connect } from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startControllerTransport } from '../../src/main/controllerTransport';
import { registerControllerTerminal } from '../../src/main/controllerClient';
import { resolveControllerEndpoint } from '../../src/main/controllerEndpoint';
import { workStatus, type WorkStatus } from '../helpers/controllerStatusFixture';

it('publishes an explicit oversized fallback through real sockets and recovers on the next status', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'at-bounds-')));
  const server = await startControllerTransport(root);
  let publish: (work: WorkStatus) => void = () => {};
  const stop = registerControllerTerminal(root, { launchDirectory: '/repo', repositoryRoot: '/repo' }, () => 'activated', () => {}, listener => {
    publish = listener;
    listener(workStatus({ attention: { status: 'complete', reasons: ['é'.repeat(1024 * 1024)] } }));
    return () => {};
  });
  try {
    await expect.poll(() => server.terminals()[0]?.work).toMatchObject({ unavailableReason: 'message-too-large' });
    expect(await server.activate(server.terminals()[0].id)).toBe('activated');
    const current = workStatus({ attention: { status: 'complete', reasons: ['Review required'] } });
    publish(current);
    await expect.poll(() => server.terminals()[0]?.work).toEqual(current);
  } finally { stop(); await server.dispose(); rmSync(root, { recursive: true, force: true }); }
});

it.each([false, true])('closes a stalled fragmented transfer without further input (registered=%s)', async registered => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'at-expiry-')));
  const server = await startControllerTransport(root);
  const socket = connect(resolveControllerEndpoint(root));
  try {
    await once(socket, 'connect');
    if (registered) {
      const ack = once(socket, 'data');
      socket.write(JSON.stringify({ version: 1, type: 'register', launchDirectory: '/repo', repositoryRoot: '/repo' }) + '\n');
      await ack;
    }
    const closed = once(socket, 'close');
    socket.write(JSON.stringify({ version: 1, type: 'status-part', text: '{', last: false }) + '\n');
    await closed;
    expect(socket.destroyed).toBe(true);
    await expect.poll(() => server.terminals().every(terminal => terminal.status === 'disconnected')).toBe(true);
  } finally { socket.destroy(); await server.dispose(); rmSync(root, { recursive: true, force: true }); }
}, 8000);
