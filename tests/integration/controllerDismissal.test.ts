import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connect, type Socket } from 'node:net';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startControllerTransport } from '../../src/main/controllerTransport';
import { resolveControllerEndpoint } from '../../src/main/controllerEndpoint';
import { createControllerDecoder, encodeControllerMessage } from '../../src/shared/controllerProtocol';
import type { ControllerTerminal } from '../../src/shared/ipc';

type Transport = Awaited<ReturnType<typeof startControllerTransport>> & { dismiss?(id: string): void };

describe('controller stale representations', () => {
  let home: string;
  let server: Transport;
  const sockets: Socket[] = [];
  beforeEach(async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'at-dismiss-')));
    server = await startControllerTransport(home);
  });
  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.destroy();
    await server.dispose();
    rmSync(home, { recursive: true, force: true });
  });

  async function peer(directory: string) {
    const before = new Set(server.terminals().map(item => item.id));
    const socket = connect(resolveControllerEndpoint(home));
    sockets.push(socket);
    socket.on('error', () => socket.destroy());
    const decoder = createControllerDecoder();
    let confirmed = false;
    let activations = 0;
    socket.on('data', (chunk: Buffer) => {
      for (const message of decoder.push(chunk)) {
        if (message.type === 'registered') confirmed = true;
        if (message.type === 'activate') {
          activations++;
          socket.write(encodeControllerMessage({ version: 1, type: 'result', requestId: message.requestId, outcome: 'activated' }));
        }
      }
    });
    socket.write(encodeControllerMessage({ version: 1, type: 'register', launchDirectory: directory, repositoryRoot: '/work' }));
    await vi.waitFor(() => expect(confirmed).toBe(true));
    const terminal = server.terminals().find(item => !before.has(item.id) && item.status !== 'disconnected')!;
    return { socket, terminal, activations: () => activations };
  }

  async function disconnect(client: Awaited<ReturnType<typeof peer>>) {
    client.socket.destroy();
    await vi.waitFor(() => expect(server.terminals().find(item => item.id === client.terminal.id)?.status).toBe('disconnected'));
  }

  it('dismisses only the selected retained occurrence and publishes the resulting empty snapshot', async () => {
    const client = await peer('/work/a');
    await disconnect(client);
    let published: ControllerTerminal[] = [];
    const unsubscribe = server.subscribeTerminals(items => { published = items; });
    try {
      await server.dismiss?.(client.terminal.id);
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
    if (order === 'dismiss first') await server.dismiss?.(stale.terminal.id);
    const replacement = await peer('/work/a');
    await server.dismiss?.(stale.terminal.id);
    expect.soft(server.terminals()).toEqual([replacement.terminal]);
    expect(await server.activate(replacement.terminal.id)).toBe('activated');
  });

  it('ignores dismissal of live or unknown identities and preserves unrelated stale entries', async () => {
    const stale = await peer('/work/a');
    await disconnect(stale);
    const live = await peer('/work/b');
    await server.dismiss?.(live.terminal.id);
    await server.dismiss?.('unknown');
    expect.soft(server.terminals()).toEqual([{ ...stale.terminal, status: 'disconnected' }, live.terminal]);
    expect(await server.activate(live.terminal.id)).toBe('activated');
  });

  it('an older live socket closing after registration cannot demote or remove its live peer', async () => {
    const older = await peer('/work/a');
    const newer = await peer('/work/a');
    await disconnect(older);
    expect.soft(server.terminals().find(item => item.id === newer.terminal.id)).toEqual(newer.terminal);
    expect(await server.activate(newer.terminal.id)).toBe('activated');
  });

  it('dismisses one occurrence while preserving same-directory and other-directory stale entries and a live peer', async () => {
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
      await server.dismiss?.(selected.terminal.id);
      const expected = [
        { ...sameDirectory.terminal, status: 'disconnected' },
        { ...otherDirectory.terminal, status: 'disconnected' },
        live.terminal,
      ];
      expect.soft(server.terminals()).toEqual(expected);
      expect.soft(published).toEqual(expected);
      expect(await server.activate(live.terminal.id)).toBe('activated');
    } finally { unsubscribe(); }
  });

});
