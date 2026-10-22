import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { connect, type Socket } from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveControllerEndpoint } from '../../src/main/controllerEndpoint';
import { registerControllerTerminal } from '../../src/main/controllerClient';
import type { ControllerIdentity } from '../../src/main/controllerIdentity';
import { startControllerTransport } from '../../src/main/controllerTransport';
import { CONTROLLER_CH, SESSION_ID, type ControllerSnapshot } from '../../src/shared/ipc';
import { installControllerIpc } from '../../src/main/controllerIpc';
import { workStatus, type WorkStatus } from '../helpers/controllerStatusFixture';

vi.mock('electron', () => ({ ipcMain: {
  on() {}, removeListener() {}, handle() {}, removeHandler() {},
} }));

let disposeIpc: (() => void) | undefined;
let stopClient: (() => void) | undefined;
let snapshot: ControllerSnapshot;
let root: string;
let server: Awaited<ReturnType<typeof startControllerTransport>>;
const sockets: Socket[] = [];

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'at-status-')));
  server = await startControllerTransport(root);
});
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  stopClient?.();
  stopClient = undefined;
  disposeIpc?.();
  disposeIpc = undefined;
  await server?.dispose();
  rmSync(root, { recursive: true, force: true });
});

async function register(directory: string) {
  const socket = connect(resolveControllerEndpoint(root));
  sockets.push(socket);
  socket.on('error', () => socket.destroy());
  await once(socket, 'connect');
  const acknowledgement = once(socket, 'data');
  socket.write(JSON.stringify({ version: 1, type: 'register', launchDirectory: directory, repositoryRoot: '/repo' }) + '\n');
  await acknowledgement;
  return socket;
}

function publish(socket: Socket, work: WorkStatus) {
  socket.write(JSON.stringify({ version: 1, type: 'status', work }) + '\n');
}

it('publishes complete current work only for the socket owning the terminal', async () => {
  const left = await register('/repo/left');
  await register('/repo/right');
  const work = workStatus({ attention: { status: 'complete', reasons: ['Review required'] }, error: { reason: 'Checks failed' } });
  publish(left, work);
  await expect.poll(() => server.terminals()).toEqual([
    { id: expect.any(String), launchDirectory: '/repo/left', repositoryRoot: '/repo', work },
    { id: expect.any(String), launchDirectory: '/repo/right', repositoryRoot: '/repo' },
  ]);
});

it('a new subscriber receives the latest complete status including cleared conditions', async () => {
  const socket = await register('/repo/current');
  const old = workStatus({ attention: { status: 'error', reasons: ['Old halt'] }, error: { reason: 'Old failure' } });
  const current = workStatus({ flow: { availability: 'known', name: 'next', step: 'verify', assignment: 'assigned' }, ticket: { availability: 'none' }, activity: 'quiet' });
  socket.write([old, current].map(work => JSON.stringify({ version: 1, type: 'status', work })).join('\n') + '\n');
  let snapshot: ReturnType<typeof server.terminals> = [];
  const unsubscribe = server.subscribeTerminals(items => { snapshot = items; });
  try {
    await expect.poll(() => snapshot).toEqual([expect.objectContaining({ launchDirectory: '/repo/current', work: current })]);
  } finally { unsubscribe(); }
});

it('publishes a complete accessible reason through the real client beyond one legacy frame', async () => {
  const reason = 'The current check needs a human decision. '.repeat(1000);
  const work = workStatus({ attention: { status: 'complete', reasons: [reason] } });
  const registerWithStatus: (
    home: string, identity: ControllerIdentity, activate: () => 'activated' | 'unavailable',
    onRegistered: () => void, subscribeStatus: (listener: (work: WorkStatus) => void) => () => void,
  ) => () => void = registerControllerTerminal;
  stopClient = registerWithStatus(root, { launchDirectory: '/repo/long-reason', repositoryRoot: '/repo' }, () => 'activated', () => {}, listener => {
    listener(work);
    return () => {};
  });
  await expect.poll(() => server.terminals()).toEqual([expect.objectContaining({ work })]);
});

it('carries real-socket status through the actual controller IPC snapshot boundary', async () => {
  const socket = await register('/repo/ipc');
  const work = workStatus({ activity: 'quiet' });
  snapshot = { sessionId: SESSION_ID, terminals: [] };
  disposeIpc = installControllerIpc({
    isDestroyed: () => false,
    send(channel: string, value: ControllerSnapshot) { if (channel === CONTROLLER_CH.terminals) snapshot = value; },
  }, server);
  publish(socket, work);
  await expect.poll(() => snapshot).toMatchObject({ sessionId: SESSION_ID, terminals: [expect.objectContaining({ launchDirectory: '/repo/ipc', work })] });
});
