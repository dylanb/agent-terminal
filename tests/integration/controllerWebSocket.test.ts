import { expect, it } from 'vitest';
import { connect } from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { startControllerTransport } from '../../src/main/controllerTransport';
import { resolveControllerEndpoint } from '../../src/main/controllerEndpoint';
import { workStatus } from '../helpers/controllerStatusFixture';

it('accepts standard WebSockets on a literal Unix path and completes a slow fragmented Unicode snapshot', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'at-ws:?-')));
  const server = await startControllerTransport(root);
  const peer = new WebSocket('ws://localhost', { createConnection: () => connect(resolveControllerEndpoint(root)) });
  peer.on('error', () => {});
  try {
    await once(peer, 'open');
    const ack = once(peer, 'message');
    peer.send(JSON.stringify({ version: 1, type: 'register', launchDirectory: '/repo/café', repositoryRoot: '/repo' }));
    expect(JSON.parse((await ack)[0].toString())).toEqual({ version: 1, type: 'registered' });
    const work = workStatus({ error: { reason: 'é🙂\\"\n'.repeat(10000) } });
    const payload = Buffer.from(JSON.stringify({ version: 1, type: 'status', work }));
    const split = payload.indexOf(Buffer.from('🙂')) + 1;
    peer.send(payload.subarray(0, split), { binary: false, fin: false });
    await delay(5100);
    expect(peer.readyState).toBe(WebSocket.OPEN);
    expect(server.terminals()[0].work).toBeUndefined();
    peer.send(payload.subarray(split), { binary: false, fin: true });
    await expect.poll(() => server.terminals()[0].work).toEqual(work);
  } finally { peer.terminate(); await server.dispose(); rmSync(root, { recursive: true, force: true }); }
}, 10000);

it.each(['payload', 'fragments', 'utf8', 'binary', 'json', 'version', 'control-size'] as const)(
  'rejects invalid %s input without publishing partial status or disturbing another terminal', async invalid => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'at-ws-limit-')));
    const server = await startControllerTransport(root);
    const peers: WebSocket[] = [];
    try {
      for (const directory of ['/bad', '/healthy']) {
        const peer = new WebSocket('ws://localhost', { createConnection: () => connect(resolveControllerEndpoint(root)) });
        peers.push(peer);
        peer.on('error', () => {});
        await once(peer, 'open');
        const ack = once(peer, 'message');
        peer.send(JSON.stringify({ version: 1, type: 'register', launchDirectory: directory, repositoryRoot: null }));
        await ack;
      }
      const [bad, healthy] = peers;
      const closed = once(bad, 'close');
      if (invalid === 'payload') {
        bad.send('x'.repeat(1024 * 1024), { fin: false });
        bad.send('x', { fin: false });
      } else if (invalid === 'fragments') {
        for (let i = 0; i < 1025; i++) bad.send(' ', { fin: false });
      } else if (invalid === 'utf8') bad.send(Buffer.from([0xff]), { binary: false });
      else if (invalid === 'binary') bad.send(Buffer.from('{}'));
      else if (invalid === 'json') bad.send('not JSON');
      else if (invalid === 'version') bad.send(JSON.stringify({ version: 2, type: 'status', work: workStatus() }));
      else bad.send(JSON.stringify({ version: 1, type: 'result', requestId: 'x'.repeat(16 * 1024), outcome: 'activated' }));
      await closed;
      await expect.poll(() => server.terminals().find(item => item.launchDirectory === '/bad')).toMatchObject({ status: 'disconnected' });
      expect(server.terminals().find(item => item.launchDirectory === '/bad')?.work).toBeUndefined();
      healthy.send(JSON.stringify({ version: 1, type: 'status', work: workStatus() }));
      await expect.poll(() => server.terminals().find(item => item.launchDirectory === '/healthy')?.work).toEqual(workStatus());
    } finally { for (const peer of peers) peer.terminate(); await server.dispose(); rmSync(root, { recursive: true, force: true }); }
  },
);

it('disposes an incomplete HTTP upgrade and allows a fresh controller to own the endpoint', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'at-ws-http-')));
  let server = await startControllerTransport(root);
  const peer = connect(resolveControllerEndpoint(root));
  try {
    await once(peer, 'connect');
    peer.write('GET / HTTP/1.1\r\n');
    await server.dispose();
    server = await startControllerTransport(root);
    expect(server.terminals()).toEqual([]);
  } finally { peer.destroy(); await server.dispose(); rmSync(root, { recursive: true, force: true }); }
});
