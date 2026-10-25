import WebSocket from 'ws';
import { connectWebSocket } from '../helpers/controllerWebSocket';
import { resolveControllerEndpoint } from '../../src/main/controllerEndpoint';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connect, createServer, type Socket } from 'node:net';
import { once } from 'node:events';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { startControllerTransport, CONTROLLER_ACTIVATION_TIMEOUT_MS } from '../../src/main/controllerTransport';
import { parseControllerMessage, encodeControllerMessage, type ControllerMessage } from '../../src/shared/controllerProtocol';

describe('controller real local transport', () => {
  let root: string;
  let appHome: string;
  const peers: WebSocket[] = [];
  let server: Awaited<ReturnType<typeof startControllerTransport>> | undefined;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'at-socket-')));
    appHome = join(root, 'state');
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const peer of peers.splice(0)) peer.terminate();
    await server?.dispose();
    server = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  async function peer(directory: string): Promise<WebSocket> {
    const socket = connectWebSocket(resolveControllerEndpoint(appHome));
    peers.push(socket);
    await once(socket, 'open');
    socket.send(encodeControllerMessage({ version: 2, type: 'register', launchDirectory: directory, repositoryRoot: null }));
    return socket;
  }

  async function registeredPeer(directory: string) {
    const previous = new Set(server!.terminals().map(terminal => terminal.id));
    const socket = await peer(directory);
    const received: ControllerMessage[] = [];
    socket.on('message', chunk => {
      const message = parseControllerMessage(chunk.toString());
      if (message.type === 'activate') received.push(message);
    });
    await vi.waitFor(() => expect(server!.terminals().some(terminal => terminal.launchDirectory === directory && !previous.has(terminal.id))).toBe(true));
    return { socket, received, id: server!.terminals().find(terminal => terminal.launchDirectory === directory && !previous.has(terminal.id))!.id };
  }

  it.each(['close', 'terminate'] as const)('retains identifying disconnected state after peer %s, including the last pane', async loss => {
    server = await startControllerTransport(appHome);
    const terminal = await registeredPeer('/work/retained');
    const updates: ReturnType<typeof server.terminals>[] = [];
    const unsubscribe = server.subscribeTerminals(items => updates.push(items));
    terminal.socket[loss]();
    await vi.waitFor(() => expect(updates.length).toBeGreaterThan(1));
    expect.soft(server.terminals()).toEqual([expect.objectContaining({
      id: terminal.id, launchDirectory: '/work/retained', repositoryRoot: null, status: 'disconnected',
    })]);
    expect.soft(updates.at(-1)).toEqual([expect.objectContaining({ id: terminal.id, status: 'disconnected' })]);
    expect(await server.activate(terminal.id)).toBe('unavailable');
    unsubscribe();
  });

  it('creates a private endpoint and accepts registration on a first run with no app-state root', async () => {
    rmSync(appHome, { recursive: true, force: true });
    server = await startControllerTransport(appHome);
    await peer('/work/first');
    expect.soft(statSync(dirname(resolveControllerEndpoint(appHome))).mode & 0o777).toBe(0o700);
    await vi.waitFor(() => expect(server!.terminals()).toEqual([
      { id: expect.any(String), launchDirectory: '/work/first', repositoryRoot: null },
    ]));
  });

  it.each(['permissions', 'ownership', 'file', 'symlink'] as const)(
    'rejects an existing endpoint directory with unsafe %s without changing it', async kind => {
      const directory = dirname(resolveControllerEndpoint(appHome));
      mkdirSync(appHome, { recursive: true, mode: 0o700 });
      const target = join(root, 'target');
      if (kind === 'file') writeFileSync(directory, 'leave this file alone');
      else if (kind === 'symlink') {
        mkdirSync(target, { mode: 0o700 });
        symlinkSync(target, directory);
      } else {
        mkdirSync(directory, { mode: 0o700 });
        if (kind === 'permissions') chmodSync(directory, 0o777);
        if (kind === 'ownership') vi.spyOn(process, 'getuid').mockReturnValue(statSync(directory).uid + 1);
      }
      const outcome = await startControllerTransport(appHome).then(value => {
        server = value;
        return 'listening';
      }, () => 'rejected');
      expect.soft(outcome).toBe('rejected');
      if (kind === 'permissions') expect(statSync(directory).mode & 0o777).toBe(0o777);
      if (kind === 'file') expect(readFileSync(directory, 'utf8')).toBe('leave this file alone');
      if (kind === 'symlink') expect(existsSync(join(target, 'socket'))).toBe(false);
    },
  );

  it.each(['file', 'symlink'] as const)(
    'preserves an existing %s at the socket endpoint and permits registration after its removal', async kind => {
      const endpoint = resolveControllerEndpoint(appHome);
      mkdirSync(dirname(endpoint), { recursive: true, mode: 0o700 });
      const target = join(root, 'endpoint-target');
      writeFileSync(target, 'target contents');
      if (kind === 'file') writeFileSync(endpoint, 'endpoint contents');
      else symlinkSync(target, endpoint);
      const original = lstatSync(endpoint);
      const outcome = await startControllerTransport(appHome).then(value => {
        server = value;
        return 'listening';
      }, () => 'rejected');
      expect.soft(outcome).toBe('rejected');
      const preserved = lstatSync(endpoint, { throwIfNoEntry: false });
      expect.soft(preserved?.ino).toBe(original.ino);
      expect.soft(preserved?.mode).toBe(original.mode);
      expect.soft(readFileSync(target, 'utf8')).toBe('target contents');
      if (preserved?.isFile()) expect.soft(readFileSync(endpoint, 'utf8')).toBe('endpoint contents');
      if (kind === 'symlink') {
        expect.soft(preserved?.isSymbolicLink()).toBe(true);
        if (preserved?.isSymbolicLink()) expect.soft(readlinkSync(endpoint)).toBe(target);
      }
      await server?.dispose();
      server = undefined;
      rmSync(endpoint, { force: true });
      const recovery = await startControllerTransport(appHome).then(value => {
        server = value;
        return 'listening';
      }, () => 'rejected');
      expect(recovery, 'rejected startup must release ownership').toBe('listening');
      await registeredPeer('/work/after-obstruction');
    },
  );

  it('preserves an independent live listener and permits registration after it closes', async () => {
    const endpoint = resolveControllerEndpoint(appHome);
    mkdirSync(dirname(endpoint), { recursive: true, mode: 0o700 });
    const connections = new Set<Socket>();
    const original = createServer(socket => {
      connections.add(socket);
      socket.on('close', () => connections.delete(socket));
      socket.on('error', () => {});
      socket.end('original listener');
    });
    try {
      original.listen(endpoint);
      await once(original, 'listening');
      const inode = lstatSync(endpoint).ino;
      const outcome = await startControllerTransport(appHome).then(value => {
        server = value;
        return 'listening';
      }, () => 'rejected');
      expect.soft(outcome).toBe('rejected');
      expect.soft(lstatSync(endpoint, { throwIfNoEntry: false })?.ino).toBe(inode);
      const response = await new Promise<string>(resolve => {
        const client = connect(endpoint);
        connections.add(client);
        let data = '';
        client.setTimeout(1_000, () => { client.destroy(); resolve('timed out'); });
        client.on('data', chunk => { data += chunk.toString(); });
        client.once('end', () => resolve(data));
        client.once('error', error => resolve(error.message));
      });
      expect.soft(response).toBe('original listener');
    } finally {
      for (const socket of connections) socket.destroy();
      await new Promise<void>((resolve, reject) => original.close(error => error ? reject(error) : resolve()));
    }
    await server?.dispose();
    server = undefined;
    const recovery = await startControllerTransport(appHome).then(value => {
      server = value;
      return 'listening';
    }, () => 'rejected');
    expect(recovery, 'live-listener rejection must release ownership').toBe('listening');
    await registeredPeer('/work/after-listener');
  });


  async function leaveCrashedControllerEndpoint() {
    const entry = join(root, 'crash-controller.cjs');
    await build({
      stdin: {
        contents: `import { startControllerTransport } from './src/main/controllerTransport';
          startControllerTransport(process.argv[2]).then(() => process.stdout.write('ready\\n'));`,
        resolveDir: process.cwd(),
      },
      bundle: true, platform: 'node', format: 'cjs', outfile: entry,
    });
    const child = spawn(process.execPath, [entry, appHome], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', code => reject(new Error(`Controller exited before ready: ${code}`)));
        child.stdout!.once('data', () => resolve());
      });
    } finally {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
    expect(statSync(resolveControllerEndpoint(appHome)).isSocket()).toBe(true);
  }

  it('relaunches after a controller crash and accepts a new terminal', async () => {
    await leaveCrashedControllerEndpoint();
    const outcome = await startControllerTransport(appHome).then(value => {
      server = value;
      return 'listening';
    }, () => 'rejected');
    expect(outcome, 'a dead controller must not prevent relaunch').toBe('listening');
    await registeredPeer('/work/relaunched');
  });

  it('concurrent relaunches elect one listener and a later controller cannot replace it', async () => {
    await leaveCrashedControllerEndpoint();
    const attempts = await Promise.allSettled([startControllerTransport(appHome), startControllerTransport(appHome)]);
    const winners = attempts.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
    server = winners[0];
    for (const extra of winners.slice(1)) await extra.dispose();
    expect(winners, 'exactly one controller must recover the stale endpoint').toHaveLength(1);
    const original = await registeredPeer('/work/winner');
    const collision = await startControllerTransport(appHome).then(async value => {
      await value.dispose();
      return 'replaced';
    }, () => 'rejected');
    expect.soft(collision).toBe('rejected');
    await registeredPeer('/work/after-relaunch-collision');
    expect(server!.terminals().map(terminal => terminal.id)).toContain(original.id);
    const activation = server!.activate(original.id);
    await vi.waitFor(() => expect(original.received).toHaveLength(1));
    const request = original.received[0];
    if (request.type !== 'activate') throw new Error('Expected activation request');
    original.socket.send(encodeControllerMessage({ version: 2, type: 'result', requestId: request.requestId, outcome: 'activated' }));
    expect(await activation).toBe('activated');
  });

  it.each(['confirmation', 'disconnect', 'timeout'] as const)(
    'bounds pending activations and recovers capacity after %s', async release => {
      server = await startControllerTransport(appHome);
      const terminal = await registeredPeer('/work/saturated');
      const healthy = await registeredPeer('/work/healthy');
      const pending = Array.from({ length: 128 }, () => server!.activate(terminal.id));
      await vi.waitFor(() => expect(terminal.received).toHaveLength(128));
      let overflow: string | undefined;
      const rejected = server.activate(healthy.id).then(value => { overflow = value; return value; });
      await vi.waitFor(() => expect(overflow, 'overflow must return promptly').toBe('unavailable'));
      expect.soft(healthy.received).toEqual([]);
      if (release === 'confirmation') {
        const request = terminal.received[0];
        if (request.type !== 'activate') throw new Error('Expected activation request');
        terminal.socket.send(encodeControllerMessage({ version: 2, type: 'result', requestId: request.requestId, outcome: 'activated' }));
        expect(await pending[0]).toBe('activated');
      } else if (release === 'disconnect') {
        terminal.socket.terminate();
        expect(await Promise.all(pending)).toEqual(Array(128).fill('unavailable'));
      } else {
        expect(await Promise.all(pending)).toEqual(Array(128).fill('unavailable'));
      }
      const resumed = server.activate(healthy.id);
      await vi.waitFor(() => expect(healthy.received).toHaveLength(1));
      const request = healthy.received[0];
      if (request.type !== 'activate') throw new Error('Expected activation request');
      healthy.socket.send(encodeControllerMessage({ version: 2, type: 'result', requestId: request.requestId, outcome: 'activated' }));
      expect(await resumed).toBe('activated');
      await rejected;
    }, 10_000,
  );

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
    const malformed = connectWebSocket(resolveControllerEndpoint(appHome));
    peers.push(malformed);
    await once(malformed, 'open');
    malformed.send('not JSON');
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
      socket.on('message', (chunk: Buffer) => {
        const message = parseControllerMessage(chunk.toString());
        if (message.type === 'activate') messages.push(message);
        if (message.type === 'activate') socket.send(encodeControllerMessage({
          version: 2, type: 'result', requestId: message.requestId, outcome: 'activated',
        }));
      });
      await vi.waitFor(() => expect(server!.terminals()).toHaveLength(received.indexOf(messages) + 1));
    }
    const target = server.terminals()[1];
    const outcome = await server.activate(target.id);
    expect.soft(outcome).toBe('activated');
    await vi.waitFor(() => expect(received[1]).toEqual([
      { version: 2, type: 'activate', requestId: expect.any(String) },
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
    terminal.socket.send(encodeControllerMessage({ version: 2, type: 'result', requestId: requests[1].requestId, outcome: 'activated' }));
    terminal.socket.send(encodeControllerMessage({ version: 2, type: 'result', requestId: requests[0].requestId, outcome: 'unavailable' }));
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
    terminal.socket.send(encodeControllerMessage({ version: 2, type: 'result', requestId: request.requestId, outcome: 'activated' }));
    expect(await result).toBe('activated');
  });

  it('retains a confirmed result when that connection then ends', async () => {
    server = await startControllerTransport(appHome);
    const terminal = await registeredPeer('/work/completed');
    const result = server.activate(terminal.id);
    await vi.waitFor(() => expect(terminal.received).toHaveLength(1));
    const request = terminal.received[0];
    if (request.type !== 'activate') throw new Error('Expected activation request');
    terminal.socket.send(encodeControllerMessage({ version: 2, type: 'result', requestId: request.requestId, outcome: 'activated' }));
    expect.soft(await result).toBe('activated');
    const disconnected = new Promise<void>(resolve => {
      let initial = true;
      const unsubscribe = server!.subscribeTerminals(() => {
        if (initial) return;
        unsubscribe();
        resolve();
      });
      initial = false;
    });
    terminal.socket.close();
    await disconnected;
    expect(await result).toBe('activated');
  });

  it('returns unavailable on disconnect before confirmation and never routes the stale identity to a replacement', async () => {
    server = await startControllerTransport(appHome);
    const terminal = await registeredPeer('/work/replaced');
    let settled = false;
    const result = server.activate(terminal.id).then(value => { settled = true; return value; });
    await vi.waitFor(() => expect(terminal.received).toHaveLength(1));
    expect.soft(settled).toBe(false);
    const disconnected = new Promise<void>(resolve => {
      let initial = true;
      const unsubscribe = server!.subscribeTerminals(() => {
        if (initial) return;
        unsubscribe();
        resolve();
      });
      initial = false;
    });
    terminal.socket.close();
    await disconnected;
    expect(await result).toBe('unavailable');
    const replacement = await registeredPeer('/work/replaced');
    expect(replacement.id).not.toBe(terminal.id);
    expect(await server.activate(terminal.id)).toBe('unavailable');
    const barrier = server.activate(replacement.id);
    await vi.waitFor(() => expect(replacement.received.length).toBeGreaterThan(0));
    const barrierRequest = replacement.received.at(-1)!;
    if (barrierRequest.type !== 'activate') throw new Error('Expected activation request');
    replacement.socket.send(encodeControllerMessage({ version: 2, type: 'result', requestId: barrierRequest.requestId, outcome: 'unavailable' }));
    expect(await barrier).toBe('unavailable');
    expect(replacement.received).toEqual([{ version: 2, type: 'activate', requestId: expect.any(String) }]);
  });

  it('bounds an unresponsive activation and ignores its late reply while a new request is pending', async () => {
    server = await startControllerTransport(appHome);
    const terminal = await registeredPeer('/work/deadline');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let settled = false;
    const delivered = once(terminal.socket, 'message');
    const result = server.activate(terminal.id).then(value => { settled = true; return value; });
    await delivered;
    const request = terminal.received[0];
    if (request.type !== 'activate') throw new Error('Expected activation request');
    await vi.advanceTimersByTimeAsync(CONTROLLER_ACTIVATION_TIMEOUT_MS - 1);
    expect.soft(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect.soft(await result).toBe('unavailable');
    const nextDelivered = once(terminal.socket, 'message');
    let nextSettled = false;
    const next = server.activate(terminal.id).then(value => { nextSettled = true; return value; });
    await nextDelivered;
    const nextRequest = terminal.received[1];
    if (nextRequest.type !== 'activate') throw new Error('Expected activation request');
    expect.soft(nextSettled).toBe(false);
    terminal.socket.send(encodeControllerMessage({ version: 2, type: 'result', requestId: request.requestId, outcome: 'unavailable' }));
    terminal.socket.send(encodeControllerMessage({ version: 2, type: 'result', requestId: nextRequest.requestId, outcome: 'activated' }));
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
    other.socket.send(encodeControllerMessage({ version: 2, type: 'result', requestId: request.requestId, outcome: 'activated' }));
    other.socket.send(encodeControllerMessage({ version: 2, type: 'result', requestId: barrierRequest.requestId, outcome: 'unavailable' }));
    expect(await barrier).toBe('unavailable');
    expect.soft(settled).toBe(false);
    owner.socket.send(encodeControllerMessage({ version: 2, type: 'result', requestId: request.requestId, outcome: 'activated' }));
    expect(await result).toBe('activated');
  });
});
