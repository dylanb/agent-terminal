import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { connect, type Socket } from 'node:net';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveControllerEndpoint } from '../../src/main/controllerEndpoint';
import { encodeControllerMessage } from '../../src/shared/controllerProtocol';
import { CONTROLLER_CH, SESSION_ID, type ControllerSnapshot } from '../../src/shared/ipc';
import { startControllerTransport } from '../../src/main/controllerTransport';
import { installControllerIpc } from '../../src/main/controllerIpc';

const boundary = vi.hoisted(() => ({
  handlers: new Map<string, (event: { sender: unknown }, payload: unknown) => unknown>(),
  listeners: new Map<string, (event: { sender: unknown }) => void>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    on(channel: string, listener: (event: { sender: unknown }) => void) { boundary.listeners.set(channel, listener); },
    removeListener(channel: string) { boundary.listeners.delete(channel); },
    handle(channel: string, handler: (event: { sender: unknown }, payload: unknown) => unknown) { boundary.handlers.set(channel, handler); },
    removeHandler(channel: string) { boundary.handlers.delete(channel); },
  },
}));

let home: string;
let transport: Awaited<ReturnType<typeof startControllerTransport>>;
let dispose: () => void;
let snapshot: ControllerSnapshot;
let deliveries: number;
const contents = {
  isDestroyed: () => false,
  send(channel: string, value: ControllerSnapshot) {
    if (channel === CONTROLLER_CH.terminals) { snapshot = value; deliveries++; }
  },
};
const sockets: Socket[] = [];
beforeEach(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'at-ipc-')));
  snapshot = { sessionId: SESSION_ID, terminals: [] };
  deliveries = 0;
  transport = await startControllerTransport(home);
  dispose = installControllerIpc(contents, transport);
});

afterEach(async () => {
  dispose?.();
  for (const socket of sockets.splice(0)) socket.destroy();
  await transport?.dispose();
  rmSync(home, { recursive: true, force: true });
});

async function register(directory: string, disconnect = true) {
  const socket = connect(resolveControllerEndpoint(home));
  sockets.push(socket);
  socket.on('error', () => socket.destroy());
  socket.write(encodeControllerMessage({ version: 1, minor: 0, type: 'register', launchDirectory: directory, repositoryRoot: '/work' }));
  await vi.waitFor(() => expect(snapshot.terminals.some(item => item.launchDirectory === directory)).toBe(true));
  const terminal = snapshot.terminals.find(item => item.launchDirectory === directory)!;
  if (disconnect) {
    socket.destroy();
    await vi.waitFor(() => expect(snapshot.terminals.find(item => item.id === terminal.id)?.status).toBe('disconnected'));
  }
  return terminal.id;
}

it.each(['foreign sender', 'incorrect session', 'missing session', 'non-string id', 'null payload'] as const)(
  'rejects %s without removing a retained pane and permits only the authorized occurrence', async invalid => {
    const selected = await register('/work/selected');
    await register('/work/other');
    await register('/work/live', false);
    const before = snapshot.terminals;
    const sender = contents;
    const payload = invalid === 'null payload' ? null
      : invalid === 'missing session' ? { id: selected }
      : { sessionId: invalid === 'incorrect session' ? 'wrong' : SESSION_ID, id: invalid === 'non-string id' ? 42 : selected };
    const dismiss = boundary.handlers.get(CONTROLLER_CH.dismiss)!;
    await dismiss({ sender: invalid === 'foreign sender' ? {} : sender }, payload);
    expect(snapshot.terminals).toHaveLength(before.length);
    expect(snapshot.terminals).toEqual(expect.arrayContaining(before));
    await dismiss({ sender }, { sessionId: SESSION_ID, id: selected });
    expect(snapshot.terminals).toHaveLength(before.length - 1);
    expect(snapshot.terminals).toEqual(expect.arrayContaining(before.filter(item => item.id !== selected)));
  },
);

it('publishes current state only to the owning window and stops delivery after disposal', async () => {
  const selected = await register('/work/selected');
  const count = deliveries;
  boundary.listeners.get(CONTROLLER_CH.subscribe)!({ sender: {} });
  expect(deliveries).toBe(count);
  boundary.listeners.get(CONTROLLER_CH.subscribe)!({ sender: contents });
  expect(deliveries).toBe(count + 1);
  expect(snapshot.sessionId).toBe(SESSION_ID);
  expect(snapshot.terminals).toEqual([expect.objectContaining({ id: selected, status: 'disconnected' })]);
  dispose();
  expect(boundary.handlers.size).toBe(0);
  expect(boundary.listeners.size).toBe(0);
  const afterDisposal = deliveries;
  transport.dismiss(selected);
  expect(transport.terminals()).toEqual([]);
  expect(deliveries).toBe(afterDisposal);
});
