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
  expect(JSON.parse((await ack)[0].toString())).toEqual({ version: 2, minor: 1, type: 'registered' });
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
  await vi.waitFor(() => expect(starts).toBe(1), { timeout: 30_000 });
  await vi.waitFor(() => expect(statuses).toEqual([{ version: 2, type: 'status', work: workStatus() }]));
}, 35_000);

async function scriptedController(root: string, registered: Record<string, unknown>) {
  const endpoint = resolveControllerEndpoint(root);
  mkdirSync(dirname(endpoint), { recursive: true, mode: 0o700 });
  const peers = new Set<WebSocket>();
  const statuses: Array<{ work: Record<string, unknown> }> = [];
  const server = createWebSocketTestServer(peer => {
    peers.add(peer);
    peer.on('error', () => {});
    peer.once('message', () => {
      peer.on('message', status => statuses.push(JSON.parse(status.toString())));
      peer.send(JSON.stringify(registered));
    });
  });
  await new Promise<void>(resolve => server.listen(endpoint, resolve));
  cleanups.push(async () => {
    for (const peer of peers) peer.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  return { statuses, send: (message: unknown) => { for (const peer of peers) peer.send(JSON.stringify(message)); } };
}

const loopMessage = { id: 'message-a', kind: 'error', reason: 'the turn stalled' } as const;

it.each([
  { minor: undefined, sent: false },
  { minor: 1, sent: true },
])('sends the loop message only to a controller whose minor supports it: minor $minor', async ({ minor, sent }) => {
  const root = home();
  const controller = await scriptedController(root, { version: 2, ...(minor === undefined ? {} : { minor }), type: 'registered' });
  cleanups.push(registerControllerTerminal(root, { launchDirectory: '/work', repositoryRoot: null },
    () => 'activated', () => {}, listener => { listener(workStatus({ loopMessage })); return () => {}; }));
  await vi.waitFor(() => expect(controller.statuses).toHaveLength(1));
  expect(controller.statuses[0].work.loopMessage).toEqual(sent ? loopMessage : undefined);
});

it('hands a controller\'s dismissal of a loop message to the terminal', async () => {
  const root = home();
  const controller = await scriptedController(root, { version: 2, minor: 1, type: 'registered' });
  const dismissed: string[] = [];
  cleanups.push(registerControllerTerminal(root, { launchDirectory: '/work', repositoryRoot: null },
    () => 'activated', () => {}, listener => { listener(workStatus({ loopMessage })); return () => {}; }, () => {}, id => dismissed.push(id)));
  await vi.waitFor(() => expect(controller.statuses).toHaveLength(1));
  controller.send({ version: 2, type: 'dismiss-loop-message', id: 'message-a' });
  await vi.waitFor(() => expect(dismissed).toEqual(['message-a']));
});

async function registeredPeer(root: string, server: Awaited<ReturnType<typeof startControllerTransport>>, minor: number) {
  const peer = connectWebSocket(resolveControllerEndpoint(root));
  cleanups.push(() => peer.terminate());
  await once(peer, 'open');
  const received: unknown[] = [];
  const ack = once(peer, 'message');
  peer.send(JSON.stringify({ version: 2, minor, type: 'register', launchDirectory: `/work/minor-${minor}`, repositoryRoot: null }));
  await ack;
  peer.on('message', data => received.push(JSON.parse(data.toString())));
  peer.send(JSON.stringify({ version: 2, type: 'status', work: workStatus({ loopMessage }) }));
  await vi.waitFor(() => expect(server.terminals().find(t => t.launchDirectory === `/work/minor-${minor}`)?.work?.loopMessage).toEqual(loopMessage));
  return { id: server.terminals().find(t => t.launchDirectory === `/work/minor-${minor}`)!.id, received };
}

it('confirms registration with its own minor version', async () => {
  const root = home();
  const server = await startControllerTransport(root);
  cleanups.push(() => server.dispose());
  const peer = connectWebSocket(resolveControllerEndpoint(root));
  cleanups.push(() => peer.terminate());
  await once(peer, 'open');
  const ack = once(peer, 'message');
  peer.send(JSON.stringify({ version: 2, minor: 1, type: 'register', launchDirectory: '/work', repositoryRoot: null }));
  expect(JSON.parse((await ack)[0].toString())).toEqual({ version: 2, minor: 1, type: 'registered' });
});

it('asks a terminal to dismiss the loop message it shows, and never a replaced one or one sent to a terminal that predates loop messages', async () => {
  const root = home();
  const server = await startControllerTransport(root);
  cleanups.push(() => server.dispose());
  const current = await registeredPeer(root, server, 1);
  const older = await registeredPeer(root, server, 0);
  server.dismissLoopMessage(current.id, 'replaced-message');
  server.dismissLoopMessage(older.id, 'message-a');
  server.dismissLoopMessage(current.id, 'message-a');
  await vi.waitFor(() => expect(current.received).toEqual([{ version: 2, type: 'dismiss-loop-message', id: 'message-a' }]));
  expect(older.received).toEqual([]);
});
