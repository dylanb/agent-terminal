import { afterEach, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type WebSocket from 'ws';
import { startControllerTransport } from '../../src/main/controllerTransport';
import { registerControllerTerminal } from '../../src/main/controllerClient';
import { resolveControllerEndpoint } from '../../src/main/controllerEndpoint';
import { connectWebSocket, createWebSocketTestServer } from '../helpers/controllerWebSocket';
import { workStatus } from '../helpers/controllerStatusFixture';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); cleanups.length = 0; });
function home() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'at-version-')));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

it.each([0, 7])('accepts compatible minor %i and drops unknown fields without changing activation routing', async minor => {
  const root = home();
  const server = await startControllerTransport(root);
  cleanups.push(() => server.dispose());
  const peer = connectWebSocket(resolveControllerEndpoint(root));
  cleanups.push(() => peer.terminate());
  await once(peer, 'open');
  const ack = once(peer, 'message');
  peer.send(JSON.stringify({ version: 2, minor, type: 'register', launchDirectory: '/work/newer', repositoryRoot: null, colour: 'teal' }));
  expect(JSON.parse((await ack)[0].toString())).toEqual({ version: 2, type: 'registered' });
  expect(server.terminals()).toEqual([{ id: expect.any(String), launchDirectory: '/work/newer', repositoryRoot: null }]);
  const request = once(peer, 'message');
  const activation = server.activate(server.terminals()[0].id);
  const message = JSON.parse((await request)[0].toString());
  peer.send(JSON.stringify({ version: 2, type: 'result', requestId: message.requestId, outcome: 'activated', future: true }));
  expect(await activation).toBe('activated');
});

it.each([1, 3])('reports supported majors and closes an unsupported version %i registration', async version => {
  const root = home();
  const server = await startControllerTransport(root);
  cleanups.push(() => server.dispose());
  const peer = connectWebSocket(resolveControllerEndpoint(root));
  cleanups.push(() => peer.terminate());
  await once(peer, 'open');
  const replies: unknown[] = [];
  peer.on('message', data => replies.push(JSON.parse(data.toString())));
  const closed = once(peer, 'close');
  peer.send(JSON.stringify({ version, type: 'register', launchDirectory: '/future', repositoryRoot: null }));
  await closed;
  expect(replies).toEqual([{ type: 'incompatible', supported: { min: 2, max: 2 } }]);
  expect(server.terminals()).toEqual([]);
});

it.each([
  { supported: { min: 1, max: 1 }, update: 'controller' },
  { supported: { min: 3, max: 4 }, update: 'terminal' },
])('reports which app needs updating and retries without releasing startup: $update', async ({ supported, update }) => {
  const root = home();
  const endpoint = resolveControllerEndpoint(root);
  mkdirSync(dirname(endpoint), { recursive: true, mode: 0o700 });
  const peers = new Set<WebSocket>();
  let attempts = 0;
  const statuses: unknown[] = [];
  const registrations: unknown[] = [];
  const server = createWebSocketTestServer(peer => {
    peers.add(peer);
    peer.on('error', () => {});
    peer.once('message', data => {
      registrations.push(JSON.parse(data.toString()));
      if (++attempts === 1) {
        peer.send(JSON.stringify({ type: 'incompatible', supported }), () => peer.close());
      } else {
        peer.on('message', status => statuses.push(JSON.parse(status.toString())));
        peer.send(JSON.stringify({ version: 2, minor: 9, type: 'registered', future: true }));
      }
    });
  });
  await new Promise<void>(resolve => server.listen(endpoint, resolve));
  cleanups.push(async () => {
    for (const peer of peers) peer.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const reports: unknown[] = [];
  let starts = 0;
  const stop = registerControllerTerminal(root, { launchDirectory: '/work', repositoryRoot: null },
    () => 'activated', () => { starts++; }, listener => { listener(workStatus()); return () => {}; }, report => reports.push(report));
  cleanups.push(stop);
  await vi.waitFor(() => expect(reports).toEqual([{ update, terminalVersion: 2, controllerVersions: supported }]));
  expect(registrations[0]).toMatchObject({ version: 2, type: 'register' });
  expect(starts).toBe(0);
  expect(statuses).toEqual([]);
  await vi.waitFor(() => expect(starts).toBe(1), { timeout: 8000 });
  await vi.waitFor(() => expect(statuses).toEqual([{ version: 2, type: 'status', work: workStatus() }]));
}, 10000);
