import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { openWindowBridge, windowBridgeDir, type WindowBridge } from '../../src/main/mcpWindowBridge';
import { callWindow } from '../../src/main/mcpWindowClient';
import type { WindowRequest } from '../../src/shared/mcpBridge';
import { createVirtualClock, type VirtualClock } from '../helpers/virtualClock';

const READ: WindowRequest = { tool: 'read_state', args: {} };
const ACK_MS = 5_000;
const BUILD = 'build-1';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const undo of cleanup.splice(0).reverse()) await undo();
});

function appHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'atmcp-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function bridge(home: string, handle: (request: WindowRequest) => Promise<unknown>, build = BUILD): Promise<WindowBridge> {
  const b = await openWindowBridge({ appHome: home, build, handle });
  cleanup.push(() => b.close());
  return b;
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** A clock whose `armed` settles once the call has set its acknowledgement deadline. */
function deadlineClock(): VirtualClock & { armed: Promise<void> } {
  const clock = createVirtualClock();
  const armed = deferred();
  return {
    ...clock,
    setTimer: (cb, ms) => {
      armed.resolve();
      return clock.setTimer(cb, ms);
    },
    armed: armed.promise,
  };
}

const call = (endpoint: string, timers: VirtualClock = createVirtualClock(), build = BUILD) =>
  callWindow(endpoint, READ, { build, ackTimeoutMs: ACK_MS, timers });

describe('a call from the MCP server to its window', () => {
  it('is app unreachable when no window listens at the endpoint', async () => {
    const outcome = await call(join(appHome(), 'gone.sock'));
    expect(outcome.kind).toBe('app-unreachable');
  });

  it('is app unreachable when the window does not acknowledge within the timeout', async () => {
    const endpoint = join(appHome(), 'hung.sock');
    const held: Socket[] = [];
    const received = deferred();
    const hung: Server = createServer((socket) => {
      held.push(socket);
      socket.once('data', () => received.resolve());
    });
    await new Promise<void>((done) => hung.listen(endpoint, done));
    cleanup.push(() => new Promise<void>((done) => { held.forEach((s) => s.destroy()); hung.close(() => done()); }));

    const clock = deadlineClock();
    const pending = call(endpoint, clock);
    await Promise.race([Promise.all([clock.armed, received.promise]), pending]);
    clock.advanceBy(ACK_MS);
    expect((await pending).kind).toBe('app-unreachable');
  });

  it('runs nothing in a window when the call gave up as app unreachable before the acknowledgement arrived', async () => {
    let ran = 0;
    const window = await bridge(appHome(), async (request) => {
      if (request.tool === READ.tool) ran += 1;
      return 'ok';
    });
    const replied = deferred();
    const relayEndpoint = join(appHome(), 'relay.sock');
    const relayed: Socket[] = [];
    const relay: Server = createServer((client) => {
      const upstream = connect(window.endpoint);
      relayed.push(client, upstream);
      client.on('error', () => undefined);
      upstream.on('error', () => undefined);
      client.on('data', (bytes) => upstream.write(bytes));
      upstream.once('data', () => replied.resolve());
    });
    await new Promise<void>((done) => relay.listen(relayEndpoint, done));
    const closeRelay = () => new Promise<void>((done) => { relayed.forEach((s) => s.destroy()); relay.close(() => done()); });
    cleanup.push(closeRelay);

    const clock = deadlineClock();
    const pending = call(relayEndpoint, clock);
    await Promise.race([Promise.all([clock.armed, replied.promise]), pending]);
    clock.advanceBy(ACK_MS);
    const outcome = await pending;
    relayed.forEach((s) => s.destroy());
    await callWindow(window.endpoint, { tool: 'ping', args: {} }, { build: BUILD, ackTimeoutMs: ACK_MS, timers: createVirtualClock() });
    expect({ outcome: outcome?.kind, ran }).toEqual({ outcome: 'app-unreachable', ran: 0 });
  });

  it('is answered, never app unreachable, when the operation takes longer than the timeout', async () => {
    const started = deferred();
    const release = deferred();
    const window = await bridge(appHome(), async (request) => {
      if (request.tool !== READ.tool) return 'pong';
      started.resolve();
      await release.promise;
      return { answer: 42 };
    });
    const clock = createVirtualClock();
    const pending = call(window.endpoint, clock);
    await Promise.race([started.promise, pending]);
    await callWindow(window.endpoint, { tool: 'ping', args: {} }, { build: BUILD, ackTimeoutMs: ACK_MS, timers: createVirtualClock() });
    clock.advanceBy(ACK_MS * 10);
    release.resolve();
    expect(await pending).toEqual({ kind: 'answered', value: { answer: 42 } });
  });

  it('is result unknown when the connection is lost after the operation started', async () => {
    const started = deferred();
    const window = await bridge(appHome(), async () => {
      started.resolve();
      return new Promise(() => {});
    });
    const pending = call(window.endpoint);
    await Promise.race([started.promise, pending]);
    await window.close();
    expect((await pending).kind).toBe('result-unknown');
  });

  it("carries the window's own reason when the operation it started fails", async () => {
    const window = await bridge(appHome(), async () => {
      throw new Error('the round report could not be parsed');
    });
    const outcome = await call(window.endpoint);
    expect(outcome).toEqual({ kind: 'result-unknown', reason: expect.stringContaining('the round report could not be parsed') });
  });

  it("is app unreachable when the window runs another build, and the window never runs it", async () => {
    let ran = 0;
    const window = await bridge(appHome(), async () => {
      ran += 1;
      return 'ran';
    }, 'build-old');
    const outcome = await call(window.endpoint, createVirtualClock(), 'build-new');
    expect({ outcome: outcome.kind, ran }).toEqual({ outcome: 'app-unreachable', ran: 0 });
  });
});

describe("a window's bridge", () => {
  it('answers only its own calls, and once closed answers none, never another window', async () => {
    const home = appHome();
    const answered = { a: 0, b: 0 };
    const a = await bridge(home, async () => (answered.a += 1, 'window A'));
    const b = await bridge(home, async () => (answered.b += 1, 'window B'));
    expect.soft(a.endpoint).not.toBe(b.endpoint);
    expect.soft(await call(a.endpoint)).toEqual({ kind: 'answered', value: 'window A' });
    expect.soft(await call(b.endpoint)).toEqual({ kind: 'answered', value: 'window B' });

    await a.close();
    let answeredByC = 0;
    const c = await bridge(home, async () => (answeredByC += 1, 'window C'));
    const orphaned = await call(a.endpoint);
    expect.soft({ orphaned: orphaned.kind, newWindowEndpoint: c.endpoint === a.endpoint, answeredByC, answered }).toEqual({
      orphaned: 'app-unreachable',
      newWindowEndpoint: false,
      answeredByC: 0,
      answered: { a: 1, b: 1 },
    });
  });

  it('keeps its endpoint under the app home, in a directory only the user can enter', async () => {
    const home = appHome();
    const window = await bridge(home, async () => 'ok');
    const dir = dirname(window.endpoint);
    expect({ underAppHome: !relative(home, dir).startsWith('..'), mode: existsSync(dir) ? statSync(dir).mode & 0o777 : null }).toEqual({ underAppHome: true, mode: 0o700 });
  });

  it('refuses to open in an endpoint directory that others can enter, as the controller does', async () => {
    const home = appHome();
    const dir = windowBridgeDir(home);
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o755);
    const opened = await openWindowBridge({ appHome: home, build: BUILD, handle: async () => 'ok' }).then(
      (b) => (cleanup.push(() => b.close()), 'opened'),
      () => 'refused',
    );
    expect(opened).toBe('refused');
  });
});
