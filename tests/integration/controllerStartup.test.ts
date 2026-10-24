import WebSocket from 'ws';
import { connectWebSocket, createWebSocketTestServer } from '../helpers/controllerWebSocket';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { registerControllerTerminal } from '../../src/main/controllerClient';
import { resolveControllerEndpoint } from '../../src/main/controllerEndpoint';
import { startControllerTransport } from '../../src/main/controllerTransport';
import { encodeControllerMessage } from '../../src/shared/controllerProtocol';

const identity = { launchDirectory: '/work/startup', repositoryRoot: null };

describe('initial controller registration', () => {
  let home: string;
  let listener: Server | undefined;
  let transport: Awaited<ReturnType<typeof startControllerTransport>> | undefined;
  let cancel: (() => void) | undefined;
  const sockets = new Set<WebSocket>();
  beforeEach(() => { home = realpathSync(mkdtempSync(join(tmpdir(), 'at-c2-'))); });
  afterEach(async () => {
    cancel?.();
    cancel = undefined;
    vi.useRealTimers();
    for (const socket of sockets) socket.terminate();
    sockets.clear();
    if (listener) await new Promise<void>(resolve => listener!.close(() => resolve()));
    listener = undefined;
    await transport?.dispose();
    transport = undefined;
    rmSync(home, { recursive: true, force: true });
  });
  async function listen(onConnection: (socket: WebSocket) => void) {
    mkdirSync(dirname(resolveControllerEndpoint(home)), { recursive: true, mode: 0o700 });
    listener = createWebSocketTestServer(socket => {
      sockets.add(socket);
      socket.on('error', () => socket.terminate());
      socket.on('close', () => sockets.delete(socket));
      onConnection(socket);
    });
    await new Promise<void>(resolve => listener!.listen(resolveControllerEndpoint(home), resolve));
  }

  it('confirms registration only after publishing the accepted identity to subscribers', async () => {
    transport = await startControllerTransport(home);
    let published = false;
    transport.subscribeTerminals(items => { published = items.some(item => item.launchDirectory === identity.launchDirectory); });
    const peer = connectWebSocket(resolveControllerEndpoint(home));
    sockets.add(peer);
    const frames: Array<{ message: unknown; published: boolean }> = [];
    peer.on('message', chunk => frames.push({ message: JSON.parse(chunk.toString()), published }));
    await once(peer, 'open');
    peer.send(encodeControllerMessage({ version: 2, type: 'register', ...identity }));
    await vi.waitFor(() => expect(frames).toEqual([{ message: { version: 2, type: 'registered' }, published: true }]));
  });

  it.each(['interrupted', 'malformed', 'silent'] as const)('retries %s initial registration within the documented real-time bounds without overlap', async mode => {
    const attempts: number[] = [];
    let active = 0;
    let peak = 0;
    await listen(socket => {
      attempts.push(performance.now());
      peak = Math.max(peak, ++active);
      socket.on('close', () => { active--; });
      socket.once('message', () => {
        if (mode === 'interrupted') socket.terminate();
        if (mode === 'malformed') socket.send('not JSON');
      });
    });
    cancel = registerControllerTerminal(home, identity, () => 'activated');
    await delay(16_500);
    expect.soft(attempts.length, 'sustained outage must produce at least three attempts').toBeGreaterThanOrEqual(3);
    expect.soft(attempts.length, 'retry must remain slow').toBeLessThanOrEqual(4);
    expect.soft(peak, 'only one pending registration at a time').toBe(1);
    for (let i = 1; i < attempts.length; i++) {
      const elapsedMs = Math.round(attempts[i] - attempts[i - 1]);
      expect.soft(elapsedMs).toBeGreaterThanOrEqual(5_000);
      expect.soft(elapsedMs).toBeLessThanOrEqual(8_000);
    }
    cancel();
    const countAtClose = attempts.length;
    await delay(8_100);
    expect(attempts.length, 'closing stops future attempts').toBe(countAtClose);
  }, 30_000);

  it('uses the two-second pending deadline and five-second retry delay', async () => {
    const attempts: WebSocket[] = [];
    await listen(socket => { attempts.push(socket); socket.resume(); });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    cancel = registerControllerTerminal(home, identity, () => 'activated');
    await delay(100);
    expect(attempts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_999);
    expect.soft((attempts[0].readyState === WebSocket.CLOSED)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await delay(100);
    expect.soft((attempts[0].readyState === WebSocket.CLOSED), 'unconfirmed attempt expires at two seconds').toBe(true);
    await vi.advanceTimersByTimeAsync(4_999);
    await delay(100);
    expect.soft(attempts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await delay(100);
    expect.soft(attempts, 'next attempt starts after the five-second delay').toHaveLength(2);
  });

  it('registers automatically when an initially absent controller starts', async () => {
    cancel = registerControllerTerminal(home, identity, () => 'activated');
    await delay(100);
    transport = await startControllerTransport(home);
    await vi.waitFor(() => expect(transport!.terminals().map(item => item.launchDirectory)).toEqual([identity.launchDirectory]), { timeout: 10_000 });
  }, 12_000);

  it('cancels pending startup before a controller appears', async () => {
    cancel = registerControllerTerminal(home, identity, () => 'activated');
    cancel();
    transport = await startControllerTransport(home);
    await delay(8_100);
    expect(transport.terminals()).toEqual([]);
  }, 10_000);
});
