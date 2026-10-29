import { once } from 'node:events';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type WebSocket from 'ws';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { resolveControllerEndpoint } from '../../src/main/controllerEndpoint';
import { startControllerTransport } from '../../src/main/controllerTransport';
import { installControllerIpc } from '../../src/main/controllerIpc';
import { createControllerSettingsStore } from '../../src/main/controllerSettings';
import { controllerApi } from '../../src/preload/controller';
import { CONTROLLER_CH, SESSION_ID, type ControllerSnapshot, type ControllerTerminal } from '../../src/shared/ipc';
import { connectWebSocket } from '../helpers/controllerWebSocket';

const boundary = vi.hoisted(() => ({
  handlers: new Map<string, (event: { sender: unknown }, payload: unknown) => unknown>(),
  contents: { isDestroyed: () => false, send: (_channel: string, _value: unknown) => {} },
}));
vi.mock('electron', () => ({
  ipcMain: {
    on() {}, removeListener() {},
    handle(channel: string, handler: (event: { sender: unknown }, payload: unknown) => unknown) { boundary.handlers.set(channel, handler); },
    removeHandler(channel: string) { boundary.handlers.delete(channel); },
  },
  ipcRenderer: {
    invoke: async (channel: string, payload: unknown) => boundary.handlers.get(channel)?.({ sender: boundary.contents }, payload),
  },
}));
let home: string;
let registry: Awaited<ReturnType<typeof startControllerTransport>>;
let dispose: () => void;
let published: ControllerTerminal[];
const peers: WebSocket[] = [];
beforeEach(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'at-clear-ipc-')));
  registry = await startControllerTransport(home); published = [];
  boundary.contents.send = (channel, value) => { if (channel === CONTROLLER_CH.terminals) published = (value as ControllerSnapshot).terminals; };
  dispose = installControllerIpc(boundary.contents, registry, createControllerSettingsStore(home));
});
afterEach(async () => {
  dispose?.(); for (const peer of peers.splice(0)) peer.terminate();
  await registry?.dispose(); rmSync(home, { recursive: true, force: true });
});
async function register(directory: string) {
  const peer = connectWebSocket(resolveControllerEndpoint(home)); peers.push(peer);
  await once(peer, 'open'); const registered = once(peer, 'message');
  peer.send(JSON.stringify({ version: 2, minor: 1, type: 'register', launchDirectory: directory, repositoryRoot: '/work' }));
  await registered;
  peer.send(JSON.stringify({ version: 2, type: 'notification', notification: { conditionId: directory, message: `Approval for ${directory}` } }));
  await expect.poll(() => published.find(t => t.launchDirectory === directory)?.notifications?.length).toBe(1);
  return published.find(t => t.launchDirectory === directory)!;
}

it('round-trips Clear through preload and the installed handler, publishing deletion only for its observed target', async () => {
  const selected = await register('/work/selected'); const other = await register('/work/other');
  expect.soft(await controllerApi.clearHistory(selected.clearHistoryTarget!)).toBe('cleared');
  expect.soft(published.find(t => t.id === selected.id)?.notifications).toEqual([]);
  expect.soft(published.find(t => t.id === selected.id)?.notifications?.[0]).toBeUndefined();
  expect.soft(published.find(t => t.id === other.id)).toEqual(other);
  expect.soft(published.map(t => t.id).sort()).toEqual([selected.id, other.id].sort());
});

it.each(['foreign sender', 'wrong session', 'missing session', 'null', 'malformed target', 'missing revision', 'invalid revision', 'empty revision'] as const)('refuses %s with an unavailable reply, preserving history; authorized retry succeeds', async invalid => {
  const selected = await register('/work/selected'); const other = await register('/work/other');
  const payload = invalid === 'null' ? null : {
    ...(invalid === 'missing session' ? {} : { sessionId: invalid === 'wrong session' ? 'wrong' : SESSION_ID }),
    target: invalid === 'malformed target' ? { id: 42 } : { ...selected.clearHistoryTarget!,
      ...(invalid === 'missing revision' ? { revision: undefined } : invalid === 'invalid revision' ? { revision: 42 } : invalid === 'empty revision' ? { revision: '' } : {}),
    },
  };
  const result = await boundary.handlers.get(CONTROLLER_CH.clearHistory)?.({ sender: invalid === 'foreign sender' ? {} : boundary.contents }, payload);
  expect.soft(result).toBe('unavailable');
  expect.soft(published).toEqual(expect.arrayContaining([selected, other]));
  expect.soft(await controllerApi.clearHistory(selected.clearHistoryTarget!)).toBe('cleared');
  expect.soft(published.find(t => t.id === selected.id)?.notifications).toEqual([]);
  expect.soft(published.find(t => t.id === other.id)).toEqual(other);
});


it('returns stale through real preload/main wiring after a new arrival and preserves it until fresh retry', async () => {
  const selected = await register('/work/selected');
  peers[0].send(JSON.stringify({ version: 2, type: 'notification', notification: { conditionId: 'new', message: 'New protected arrival' } }));
  await expect.poll(() => published.find(t => t.id === selected.id)?.notifications?.length).toBe(2);
  const current = published.find(t => t.id === selected.id)!;
  expect.soft(await controllerApi.clearHistory(selected.clearHistoryTarget!)).toBe('stale');
  expect.soft(published.find(t => t.id === selected.id)?.notifications).toEqual(current.notifications);
  expect.soft(await controllerApi.clearHistory(current.clearHistoryTarget!)).toBe('cleared');
  expect.soft(published.find(t => t.id === selected.id)?.notifications).toEqual([]);
});
