import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connect, type Socket } from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { startControllerTransport, resolveControllerEndpoint, CONTROLLER_ACTIVATION_TIMEOUT_MS } from '../../src/main/controllerTransport';
import { createControllerDecoder, encodeControllerMessage, type ControllerMessage } from '../../src/shared/controllerProtocol';

describe('controller real local transport', () => {
  let root: string;
  let appHome: string;
  const peers: Socket[] = [];
  let server: Awaited<ReturnType<typeof startControllerTransport>> | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'at-socket-'));
    appHome = join(root, 'state');
  });
  afterEach(async () => {
    vi.useRealTimers();
    for (const peer of peers.splice(0)) peer.destroy();
    await server?.dispose();
    server = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  async function peer(directory: string): Promise<Socket> {
    const socket = connect(resolveControllerEndpoint(appHome));
    peers.push(socket);
    await once(socket, 'connect');
    socket.write(encodeControllerMessage({ version: 1, type: 'register', launchDirectory: directory, repositoryRoot: null }));
    return socket;
  }

  async function registeredPeer(directory: string) {
    const socket = await peer(directory);
    const received: ControllerMessage[] = [];
    const decoder = createControllerDecoder();
    socket.on('data', (chunk: Buffer) => received.push(...decoder.push(chunk)));
    await vi.waitFor(() => expect(server!.terminals().some(terminal => terminal.launchDirectory === directory)).toBe(true));
    return { socket, received, id: server!.terminals().find(terminal => terminal.launchDirectory === directory)!.id };
  }

  it('creates a private endpoint and accepts registration on a first run with no app-state root', async () => {
    rmSync(appHome, { recursive: true, force: true });
    server = await startControllerTransport(appHome);
    await peer('/work/first');
    expect.soft(statSync(dirname(resolveControllerEndpoint(appHome))).mode & 0o777).toBe(0o700);
    await vi.waitFor(() => expect(server!.terminals()).toEqual([
      { id: expect.any(String), launchDirectory: '/work/first', repositoryRoot: null },
    ]));
  });

  it('gives equal-directory connections separate opaque identities', async () => {
    server = await startControllerTransport(appHome);
    await peer('/work/same');
    await peer('/work/same');
    await vi.waitFor(() => {
      const terminals = server!.terminals();
      expect({
        count: terminals.length,
        identities: new Set(terminals.map(terminal => terminal.id)).size,
        directories: terminals.map(terminal => terminal.launchDirectory),
      }).toEqual({ count: 2, identities: 2, directories: ['/work/same', '/work/same'] });
    });
  });

  it('keeps a valid peer registerable after another peer sends malformed input', async () => {
    server = await startControllerTransport(appHome);
    const malformed = connect(resolveControllerEndpoint(appHome));
    peers.push(malformed);
    await once(malformed, 'connect');
    malformed.end('not JSON\n');
    await peer('/work/healthy');
    await vi.waitFor(() => expect(server!.terminals().map(terminal => terminal.launchDirectory)).toEqual(['/work/healthy']));
  });

  it('a second controller cannot replace the active listener or its connections', async () => {
    server = await startControllerTransport(appHome);
    await peer('/work/original');
    await expect(startControllerTransport(appHome)).rejects.toThrow();
    await peer('/work/after-collision');
    await vi.waitFor(() => expect(server!.terminals().map(terminal => terminal.launchDirectory).sort()).toEqual([
      '/work/after-collision', '/work/original',
    ]));
  });

  it('activates only the selected equal-directory connection and returns its confirmed result', async () => {
    server = await startControllerTransport(appHome);
    const received: ControllerMessage[][] = [[], []];
    for (const messages of received) {
      const socket = await peer('/work/same');
      const decoder = createControllerDecoder();
      socket.on('data', (chunk: Buffer) => {
        for (const message of decoder.push(chunk)) {
          messages.push(message);
          if (message.type === 'activate') socket.write(encodeControllerMessage({
            version: 1, type: 'result', requestId: message.requestId, outcome: 'activated',
          }));
        }
      });
      await vi.waitFor(() => expect(server!.terminals()).toHaveLength(received.indexOf(messages) + 1));
    }
    const target = server.terminals()[1];
    const outcome = await server.activate(target.id);
    expect.soft(outcome).toBe('activated');
    await vi.waitFor(() => expect(received[1]).toEqual([
      { version: 1, type: 'activate', requestId: expect.any(String) },
    ]));
    expect(received[0]).toEqual([]);
  });

  it('correlates replies to requests even when confirmations arrive in reverse order', async () => {
    server = await startControllerTransport(appHome);
    const terminal = await registeredPeer('/work/correlated');
    const first = server.activate(terminal.id);
    const second = server.activate(terminal.id);
    await vi.waitFor(() => expect(terminal.received).toHaveLength(2));
    const requests = terminal.received.filter(message => message.type === 'activate');
    expect(new Set(requests.map(request => request.requestId)).size).toBe(2);
    terminal.socket.write(encodeControllerMessage({ version: 1, type: 'result', requestId: requests[1].requestId, outcome: 'activated' }));
    terminal.socket.write(encodeControllerMessage({ version: 1, type: 'result', requestId: requests[0].requestId, outcome: 'unavailable' }));
    expect(await Promise.all([first, second])).toEqual(['unavailable', 'activated']);
  });

  it('does not complete activation before the live terminal confirms it', async () => {
    server = await startControllerTransport(appHome);
    const terminal = await registeredPeer('/work/confirmation');
    let settled = false;
    const result = server.activate(terminal.id).then(value => { settled = true; return value; });
    await vi.waitFor(() => expect(terminal.received).toHaveLength(1));
    expect.soft(settled).toBe(false);
    const request = terminal.received[0];
    if (request.type !== 'activate') throw new Error('Expected activation request');
    terminal.socket.write(encodeControllerMessage({ version: 1, type: 'result', requestId: request.requestId, outcome: 'activated' }));
    expect(await result).toBe('activated');
  });

  it('retains a confirmed result when that connection then ends', async () => {
    server = await startControllerTransport(appHome);
    const terminal = await registeredPeer('/work/completed');
    const result = server.activate(terminal.id);
    await vi.waitFor(() => expect(terminal.received).toHaveLength(1));
    const request = terminal.received[0];
    if (request.type !== 'activate') throw new Error('Expected activation request');
    terminal.socket.write(encodeControllerMessage({ version: 1, type: 'result', requestId: request.requestId, outcome: 'activated' }));
    expect.soft(await result).toBe('activated');
    terminal.socket.end();
    await vi.waitFor(() => expect(server!.terminals()).toEqual([]));
    expect(await result).toBe('activated');
  });

  it('returns unavailable on disconnect before confirmation and never routes the stale identity to a replacement', async () => {
    server = await startControllerTransport(appHome);
    const terminal = await registeredPeer('/work/replaced');
    let settled = false;
    const result = server.activate(terminal.id).then(value => { settled = true; return value; });
    await vi.waitFor(() => expect(terminal.received).toHaveLength(1));
    expect.soft(settled).toBe(false);
    terminal.socket.end();
    await vi.waitFor(() => expect(server!.terminals()).toEqual([]));
    expect(await result).toBe('unavailable');
    const replacement = await registeredPeer('/work/replaced');
    expect(replacement.id).not.toBe(terminal.id);
    expect(await server.activate(terminal.id)).toBe('unavailable');
    const barrier = server.activate(replacement.id);
    await vi.waitFor(() => expect(replacement.received.length).toBeGreaterThan(0));
    const barrierRequest = replacement.received.at(-1)!;
    if (barrierRequest.type !== 'activate') throw new Error('Expected activation request');
    replacement.socket.write(encodeControllerMessage({ version: 1, type: 'result', requestId: barrierRequest.requestId, outcome: 'unavailable' }));
    expect(await barrier).toBe('unavailable');
    expect(replacement.received).toEqual([{ version: 1, type: 'activate', requestId: expect.any(String) }]);
  });

  it('bounds an unresponsive activation and ignores its late reply while a new request is pending', async () => {
    server = await startControllerTransport(appHome);
    const terminal = await registeredPeer('/work/deadline');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let settled = false;
    const delivered = once(terminal.socket, 'data');
    const result = server.activate(terminal.id).then(value => { settled = true; return value; });
    await delivered;
    const request = terminal.received[0];
    if (request.type !== 'activate') throw new Error('Expected activation request');
    await vi.advanceTimersByTimeAsync(CONTROLLER_ACTIVATION_TIMEOUT_MS - 1);
    expect.soft(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect.soft(await result).toBe('unavailable');
    const nextDelivered = once(terminal.socket, 'data');
    let nextSettled = false;
    const next = server.activate(terminal.id).then(value => { nextSettled = true; return value; });
    await nextDelivered;
    const nextRequest = terminal.received[1];
    if (nextRequest.type !== 'activate') throw new Error('Expected activation request');
    expect.soft(nextSettled).toBe(false);
    terminal.socket.write(
      encodeControllerMessage({ version: 1, type: 'result', requestId: request.requestId, outcome: 'unavailable' })
      + encodeControllerMessage({ version: 1, type: 'result', requestId: nextRequest.requestId, outcome: 'activated' }),
    );
    expect.soft(await next).toBe('activated');
    expect(await result).toBe('unavailable');
  });

  it('accepts confirmation only from the connection that owns the activation target', async () => {
    server = await startControllerTransport(appHome);
    const owner = await registeredPeer('/work/owner');
    const other = await registeredPeer('/work/other');
    let settled = false;
    const result = server.activate(owner.id).then(value => { settled = true; return value; });
    const barrier = server.activate(other.id);
    await vi.waitFor(() => expect([owner.received.length, other.received.length]).toEqual([1, 1]));
    const request = owner.received[0];
    const barrierRequest = other.received[0];
    if (request.type !== 'activate' || barrierRequest.type !== 'activate') throw new Error('Expected activation requests');
    other.socket.write(
      encodeControllerMessage({ version: 1, type: 'result', requestId: request.requestId, outcome: 'activated' })
      + encodeControllerMessage({ version: 1, type: 'result', requestId: barrierRequest.requestId, outcome: 'unavailable' }),
    );
    expect(await barrier).toBe('unavailable');
    expect.soft(settled).toBe(false);
    owner.socket.write(encodeControllerMessage({ version: 1, type: 'result', requestId: request.requestId, outcome: 'activated' }));
    expect(await result).toBe('activated');
  });
});
