import { once } from 'node:events';
import WebSocket from 'ws';
import { connectWebSocket } from '../helpers/controllerWebSocket';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startControllerTransport } from '../../src/main/controllerTransport';
import { resolveControllerEndpoint } from '../../src/main/controllerEndpoint';
import { parseControllerMessage, encodeControllerMessage } from '../../src/shared/controllerProtocol';
import type { ControllerTerminal } from '../../src/shared/ipc';

type Transport = Awaited<ReturnType<typeof startControllerTransport>>;

describe('controller stale representations', () => {
  let home: string;
  let server: Transport;
  const sockets: WebSocket[] = [];
  beforeEach(async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'at-dismiss-')));
    server = await startControllerTransport(home);
  });
  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    await server.dispose();
    rmSync(home, { recursive: true, force: true });
  });

  async function peer(directory: string) {
    const before = new Set(server.terminals().map(item => item.id));
    const socket = connectWebSocket(resolveControllerEndpoint(home));
    sockets.push(socket);
    socket.on('error', () => socket.terminate());
    let confirmed = false;
    let activations = 0;
    socket.on('message', (chunk: Buffer) => {
      const message = parseControllerMessage(chunk.toString());
      if (message.type === 'registered') confirmed = true;
      if (message.type === 'activate') {
        activations++;
        socket.send(encodeControllerMessage({ version: 2, type: 'result', requestId: message.requestId, outcome: 'activated' }));
      }
    });
    await once(socket, 'open');
    socket.send(encodeControllerMessage({ version: 2, type: 'register', launchDirectory: directory, repositoryRoot: '/work' }));
    await vi.waitFor(() => expect(confirmed).toBe(true));
    const terminal = server.terminals().find(item => !before.has(item.id) && item.status !== 'disconnected')!;
    return { socket, terminal, activations: () => activations };
  }

  async function disconnect(client: Awaited<ReturnType<typeof peer>>) {
    client.socket.terminate();
    await vi.waitFor(() => expect(server.terminals().some(item => item.id === client.terminal.id && item.status !== 'disconnected')).toBe(false));
  }

  it.each(['read', 'subscribe'] as const)('%s snapshots cannot change live or disconnected identities', async source => {
    const live = await peer('/work/live');
    const stale = await peer('/work/stale');
    await disconnect(stale);
    const expected = server.terminals().map(item => ({ ...item }));
    let received: ControllerTerminal[] = [];
    const unsubscribe = source === 'subscribe'
      ? server.subscribeTerminals(items => { received = items; })
      : () => {};
    if (source === 'read') received = server.terminals();
    try {
      for (const item of received) {
        item.id = 'changed';
        item.launchDirectory = '/changed';
        item.repositoryRoot = null;
        item.status = 'disconnected';
      }
      received.length = 0;
      expect.soft(server.terminals()).toEqual(expect.arrayContaining(expected));
      expect.soft(server.terminals()).toHaveLength(expected.length);
      expect.soft(await server.activate(live.terminal.id)).toBe('activated');
      server.dismiss(stale.terminal.id);
      expect(server.terminals()).toEqual([live.terminal]);
    } finally { unsubscribe(); }
  });

  it('isolates notification values between subscribers and subsequent reads', async () => {
    const mutate = server.subscribeTerminals(items => {
      for (const item of items) item.launchDirectory = '/changed';
      items.length = 0;
    });
    let observed: ControllerTerminal[] = [];
    const observe = server.subscribeTerminals(items => { observed = items; });
    try {
      const client = await peer('/work/original');
      expect.soft(observed).toEqual([expect.objectContaining({ launchDirectory: '/work/original' })]);
      expect.soft(server.terminals()).toEqual([expect.objectContaining({ launchDirectory: '/work/original' })]);
      await disconnect(client);
      expect(observed).toEqual([expect.objectContaining({ launchDirectory: '/work/original', status: 'disconnected' })]);
    } finally { mutate(); observe(); }
  });

  it('dismisses only the selected retained occurrence and publishes the resulting empty snapshot', async () => {
    const client = await peer('/work/a');
    await disconnect(client);
    let published: ControllerTerminal[] = [];
    const unsubscribe = server.subscribeTerminals(items => { published = items; });
    try {
      await server.dismiss(client.terminal.id);
      expect.soft(server.terminals()).toEqual([]);
      expect.soft(published).toEqual([]);
    } finally { unsubscribe(); }
  });

  it('replaces every stale entry for the fixed directory while preserving a live peer and another directory', async () => {
    const first = await peer('/work/a');
    const second = await peer('/work/a');
    const live = await peer('/work/a');
    const other = await peer('/work/b');
    await disconnect(first);
    await disconnect(second);
    await disconnect(other);
    const replacement = await peer('/work/a');
    expect.soft(server.terminals().map(item => item.id).sort()).toEqual([live.terminal.id, other.terminal.id, replacement.terminal.id].sort());
    expect.soft(await server.activate(live.terminal.id)).toBe('activated');
    expect.soft(await server.activate(replacement.terminal.id)).toBe('activated');
    expect.soft(await server.activate(first.terminal.id)).toBe('unavailable');
    expect.soft(live.activations()).toBe(1);
    expect(replacement.activations()).toBe(1);
  });

  it.each(['dismiss first', 'register first'] as const)('accepts a later connection safely when %s races replacement', async order => {
    const stale = await peer('/work/a');
    await disconnect(stale);
    if (order === 'dismiss first') await server.dismiss(stale.terminal.id);
    const replacement = await peer('/work/a');
    await server.dismiss(stale.terminal.id);
    expect.soft(server.terminals()).toEqual([replacement.terminal]);
    expect(await server.activate(replacement.terminal.id)).toBe('activated');
  });

  it('ignores dismissal of live or unknown identities and preserves unrelated stale entries', async () => {
    const stale = await peer('/work/a');
    await disconnect(stale);
    const live = await peer('/work/b');
    await server.dismiss(live.terminal.id);
    await server.dismiss('unknown');
    expect.soft(server.terminals()).toHaveLength(2);
    expect.soft(server.terminals()).toEqual(expect.arrayContaining([{ ...stale.terminal, status: 'disconnected' }, live.terminal]));
    expect(await server.activate(live.terminal.id)).toBe('activated');
  });

  it('an older live socket closing after registration cannot demote or remove its live peer', async () => {
    const older = await peer('/work/a');
    const newer = await peer('/work/a');
    await disconnect(older);
    expect.soft(server.terminals().find(item => item.id === newer.terminal.id)).toEqual(newer.terminal);
    expect(await server.activate(newer.terminal.id)).toBe('activated');
  });

  it('discards departed peers while preserving another directory and rejects their delayed dismissal', async () => {
    const selected = await peer('/work/a');
    const sameDirectory = await peer('/work/a');
    const otherDirectory = await peer('/work/b');
    const live = await peer('/work/a');
    await disconnect(selected);
    await disconnect(sameDirectory);
    await disconnect(otherDirectory);
    let published: ControllerTerminal[] = [];
    const unsubscribe = server.subscribeTerminals(items => { published = items; });
    try {
      await server.dismiss(selected.terminal.id);
      const expected = [
        { ...otherDirectory.terminal, status: 'disconnected' },
        live.terminal,
      ];
      expect.soft(server.terminals()).toHaveLength(expected.length);
      expect.soft(server.terminals()).toEqual(expect.arrayContaining(expected));
      expect.soft(published).toHaveLength(expected.length);
      expect.soft(published).toEqual(expect.arrayContaining(expected));
      expect(await server.activate(live.terminal.id)).toBe('activated');
    } finally { unsubscribe(); }
  });

  it('retains only the last departure and rebuilds live membership through repeated reconnects', async () => {
    const other = await peer('/work/other');
    await disconnect(other);
    for (let round = 0; round < 2; round++) {
      const first = await peer('/work/shared');
      const second = await peer('/work/shared');
      const third = await peer('/work/shared');
      await disconnect(first);
      expect.soft(server.terminals().filter(item => item.launchDirectory === '/work/shared').map(item => item.id).sort())
        .toEqual([second.terminal.id, third.terminal.id].sort());
      await disconnect(second);
      expect.soft(server.terminals().filter(item => item.launchDirectory === '/work/shared')).toEqual([third.terminal]);
      await disconnect(third);
      expect.soft(server.terminals().filter(item => item.launchDirectory === '/work/shared'))
        .toEqual([{ ...third.terminal, status: 'disconnected' }]);
      expect.soft(server.terminals()).toContainEqual({ ...other.terminal, status: 'disconnected' });
      await server.dismiss(first.terminal.id);
      expect.soft(server.terminals()).toContainEqual({ ...third.terminal, status: 'disconnected' });
    }
  });

});
