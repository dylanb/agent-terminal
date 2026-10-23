import WebSocket from 'ws';
import { createWebSocketTestServer } from '../helpers/controllerWebSocket';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { registerControllerTerminal } from '../../src/main/controllerClient';
import { resolveControllerEndpoint } from '../../src/main/controllerEndpoint';
import { startControllerTransport } from '../../src/main/controllerTransport';
import { parseControllerMessage, encodeControllerMessage } from '../../src/shared/controllerProtocol';

const identity = { launchDirectory: '/work/recovery', repositoryRoot: '/work/recovery' };

describe('registered terminal recovery', () => {
  let home: string;
  let listener: Server | undefined;
  let transport: Awaited<ReturnType<typeof startControllerTransport>> | undefined;
  const peers = new Set<WebSocket>();
  const cancel: Array<() => void> = [];
  beforeEach(() => { home = realpathSync(mkdtempSync(join(tmpdir(), 'at-rec-'))); });
  afterEach(async () => {
    for (const stop of cancel.splice(0)) stop();
    vi.useRealTimers();
    for (const peer of peers) peer.terminate();
    peers.clear();
    if (listener) await new Promise<void>(resolve => listener!.close(() => resolve()));
    listener = undefined;
    await transport?.dispose();
    transport = undefined;
    rmSync(home, { recursive: true, force: true });
  });

  async function listen(onRegistration: (socket: WebSocket) => void) {
    mkdirSync(dirname(resolveControllerEndpoint(home)), { recursive: true, mode: 0o700 });
    listener = createWebSocketTestServer(socket => {
      peers.add(socket);
      socket.on('error', () => socket.terminate());
      socket.on('close', () => peers.delete(socket));
      socket.on('message', (chunk: Buffer) => {
        const message = parseControllerMessage(chunk.toString());
        if (message.type === 'register') onRegistration(socket);
      });
    });
    await new Promise<void>(resolve => listener!.listen(resolveControllerEndpoint(home), resolve));
  }

  it.each(['interrupted', 'silent', 'malformed'] as const)('bounds sustained %s retries after a confirmed connection is lost', async mode => {
    const attempts: number[] = [];
    let initial: WebSocket | undefined;
    let started = false;
    let peak = 0;
    await listen(socket => {
      attempts.push(performance.now());
      peak = Math.max(peak, peers.size);
      if (attempts.length === 1) {
        initial = socket;
        socket.send(encodeControllerMessage({ version: 1, type: 'registered' }));
      } else if (mode === 'interrupted') socket.terminate();
      else if (mode === 'malformed') socket.send('invalid');
    });
    cancel.push(registerControllerTerminal(home, identity, () => 'activated', () => { started = true; }));
    await vi.waitFor(() => expect(started).toBe(true));
    const lostAt = performance.now();
    initial!.terminate();
    await delay(21_500);
    const retries = attempts.slice(1);
    expect.soft(retries.length, 'sustained registered outage produces multiple retries').toBeGreaterThanOrEqual(3);
    expect.soft(retries.length, 'retries remain slow').toBeLessThanOrEqual(4);
    expect.soft(peak, 'registration attempts never overlap').toBe(1);
    for (let i = 0; i < retries.length; i++) {
      const gap = Math.round(retries[i] - (i === 0 ? lostAt : retries[i - 1]));
      expect.soft(gap).toBeGreaterThanOrEqual(5_000);
      expect.soft(gap).toBeLessThanOrEqual(8_000);
    }
  }, 25_000);

  it('waits five seconds after established loss and cancels a running terminal during that delay', async () => {
    let registrations = 0;
    let started = false;
    let initial: WebSocket | undefined;
    await listen(socket => {
      registrations++;
      initial = socket;
      socket.send(encodeControllerMessage({ version: 1, type: 'registered' }));
    });
    const stop = registerControllerTerminal(home, identity, () => 'activated', () => { started = true; });
    cancel.push(stop);
    await vi.waitFor(() => expect(started).toBe(true));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    initial!.terminate();
    await delay(100);
    await vi.advanceTimersByTimeAsync(4_999);
    await delay(100);
    expect.soft(registrations).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await delay(100);
    expect.soft(registrations, 'established loss retries at five seconds').toBe(2);
    initial!.terminate();
    await delay(100);
    stop();
    await vi.advanceTimersByTimeAsync(20_000);
    await delay(100);
    expect(registrations, 'closing a running terminal cancels further recovery').toBeLessThanOrEqual(2);
  });

  it('restores distinct same-directory peers through repeated real listener restarts without restarting work', async () => {
    transport = await startControllerTransport(home);
    const starts = [0, 0];
    const activations = [0, 0];
    for (const index of [0, 1]) cancel.push(registerControllerTerminal(home, identity,
      () => { activations[index]++; return 'activated'; }, () => { starts[index]++; }));
    await vi.waitFor(() => expect(starts).toEqual([1, 1]));
    for (let round = 0; round < 2; round++) {
      await transport.dispose();
      transport = undefined;
      transport = await startControllerTransport(home);
      await delay(10_000);
      const terminals = transport.terminals();
      expect.soft(terminals.map(({ launchDirectory, repositoryRoot }) => ({ launchDirectory, repositoryRoot }))).toEqual([identity, identity]);
      expect.soft(new Set(terminals.map(item => item.id)).size).toBe(2);
      for (const terminal of terminals) expect.soft(await transport.activate(terminal.id)).toBe('activated');
      expect.soft(activations).toEqual([round + 1, round + 1]);
      expect.soft(starts, 'recovery must never authorize startup a second time').toEqual([1, 1]);
    }
  }, 30_000);

  it('begins an unconfirmed recovery registration after established loss', async () => {
    const attempts: WebSocket[] = [];
    let starts = 0;
    await listen(socket => {
      attempts.push(socket);
      if (attempts.length === 1) socket.send(encodeControllerMessage({ version: 1, type: 'registered' }));
    });
    cancel.push(registerControllerTerminal(home, identity, () => 'activated', () => { starts++; }));
    await vi.waitFor(() => expect(starts).toBe(1));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    attempts[0].terminate();
    await delay(100);
    await vi.advanceTimersByTimeAsync(5_000);
    await delay(100);
    expect(attempts, 'recovery reaches an unconfirmed registration').toHaveLength(2);
  });

  it.each(['pending', 'registered'] as const)('closing a %s terminal rejects queued messages and ends its live connection', async state => {
    let peer: WebSocket | undefined;
    let starts = 0;
    let activations = 0;
    await listen(socket => {
      peer = socket;
      if (state === 'registered') socket.send(encodeControllerMessage({ version: 1, type: 'registered' }));
    });
    const stop = registerControllerTerminal(home, identity,
      () => { activations++; return 'activated'; }, () => { starts++; });
    cancel.push(stop);
    await vi.waitFor(() => expect(peer).toBeDefined());
    if (state === 'registered') await vi.waitFor(() => expect(starts).toBe(1));
    peer!.send(encodeControllerMessage(state === 'pending'
      ? { version: 1, type: 'registered' }
      : { version: 1, type: 'activate', requestId: 'queued-at-close' }));
    stop();
    await vi.waitFor(() => expect(peers.size).toBe(0));
    expect.soft(starts).toBe(state === 'registered' ? 1 : 0);
    expect(activations).toBe(0);
  });
});
