import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { connect, type Socket } from 'node:net';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveControllerEndpoint } from '../../src/main/controllerEndpoint';
import { encodeControllerMessage } from '../../src/shared/controllerProtocol';
import { CONTROLLER_CH, SESSION_ID, type ControllerSnapshot } from '../../src/shared/ipc';

const boundary = vi.hoisted(() => ({
  handlers: new Map<string, (event: { sender: unknown }, payload: unknown) => unknown>(),
  snapshot: { sessionId: '', terminals: [] } as ControllerSnapshot,
  window: undefined as undefined | { emit(event: string): boolean; webContents: unknown },
  disposal: undefined as Promise<void> | undefined,
}));

vi.mock('electron', () => ({
  app: { setName() {}, on() {}, whenReady: async () => {}, quit() {} },
  BrowserWindow: class extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), {
      setWindowOpenHandler() {},
      send(channel: string, snapshot: ControllerSnapshot) {
        if (channel === CONTROLLER_CH.terminals) boundary.snapshot = snapshot;
      },
    });
    constructor() { super(); boundary.window = this; }
    isDestroyed() { return false; }
    async loadFile() {}
    async loadURL() {}
  },
  ipcMain: {
    on() {}, removeListener() {},
    handle(channel: string, handler: (event: { sender: unknown }, payload: unknown) => unknown) { boundary.handlers.set(channel, handler); },
    removeHandler(channel: string) { boundary.handlers.delete(channel); },
  },
}));

vi.mock('../../src/main/controllerTransport', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/main/controllerTransport')>();
  return { ...original, async startControllerTransport(home: string) {
    const transport = await original.startControllerTransport(home);
    return { ...transport, dispose() { boundary.disposal = transport.dispose(); return boundary.disposal; } };
  } };
});

let home: string;
const sockets: Socket[] = [];
beforeEach(async () => {
  vi.resetModules();
  home = realpathSync(mkdtempSync(join(tmpdir(), 'at-ipc-')));
  vi.stubEnv('APP_HOME_DIR', home);
  boundary.handlers.clear();
  boundary.snapshot = { sessionId: SESSION_ID, terminals: [] };
  boundary.disposal = undefined;
  await import('../../src/main/controller');
  await vi.waitFor(() => expect(boundary.handlers.has(CONTROLLER_CH.dismiss)).toBe(true));
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  boundary.window?.emit('closed');
  await boundary.disposal;
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

async function register(directory: string, disconnect = true) {
  const socket = connect(resolveControllerEndpoint(home));
  sockets.push(socket);
  socket.on('error', () => socket.destroy());
  socket.write(encodeControllerMessage({ version: 1, type: 'register', launchDirectory: directory, repositoryRoot: '/work' }));
  await vi.waitFor(() => expect(boundary.snapshot.terminals.some(item => item.launchDirectory === directory)).toBe(true));
  const terminal = boundary.snapshot.terminals.find(item => item.launchDirectory === directory)!;
  if (disconnect) {
    socket.destroy();
    await vi.waitFor(() => expect(boundary.snapshot.terminals.find(item => item.id === terminal.id)?.status).toBe('disconnected'));
  }
  return terminal.id;
}

it.each(['foreign sender', 'incorrect session', 'missing session', 'non-string id', 'null payload'] as const)(
  'rejects %s without removing a retained pane and permits only the authorized occurrence', async invalid => {
    const selected = await register('/work/selected');
    await register('/work/other');
    await register('/work/live', false);
    const before = boundary.snapshot.terminals;
    const sender = boundary.window!.webContents;
    const payload = invalid === 'null payload' ? null
      : invalid === 'missing session' ? { id: selected }
      : { sessionId: invalid === 'incorrect session' ? 'wrong' : SESSION_ID, id: invalid === 'non-string id' ? 42 : selected };
    const dismiss = boundary.handlers.get(CONTROLLER_CH.dismiss)!;
    await dismiss({ sender: invalid === 'foreign sender' ? {} : sender }, payload);
    expect(boundary.snapshot.terminals).toEqual(before);
    await dismiss({ sender }, { sessionId: SESSION_ID, id: selected });
    expect(boundary.snapshot.terminals).toEqual(before.filter(item => item.id !== selected));
  },
);
