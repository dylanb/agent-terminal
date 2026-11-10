import { afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type WebSocket from 'ws';
import { registerControllerTerminal } from '../../src/main/controllerClient';
import { resolveControllerEndpoint } from '../../src/main/controllerEndpoint';
import { createWebSocketTestServer } from '../helpers/controllerWebSocket';
import { workStatus } from '../helpers/controllerStatusFixture';
import { CONTROLLER_PROTOCOL_MAJOR, CONTROLLER_PROTOCOL_MINOR, encodeControllerMessage, type NotificationCondition, type ControllerNotificationSource } from '../../src/shared/controllerProtocol';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); cleanups.length = 0; });

async function connect(minor: number | undefined, current: NotificationCondition | null) {
  const home = mkdtempSync(join(tmpdir(), 'at-notification-client-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const endpoint = resolveControllerEndpoint(home);
  mkdirSync(dirname(endpoint), { recursive: true });
  const peers = new Set<WebSocket>();
  const received: Array<Record<string, unknown>> = [];
  const arrivals = new Set<(notification: NotificationCondition) => void>();
  const changes = new Set<(notification: NotificationCondition | null) => void>();
  let status: ((work: ReturnType<typeof workStatus>) => void) | undefined;
  const server = createWebSocketTestServer(peer => {
    peers.add(peer);
    peer.on('message', data => {
      const frame = JSON.parse(data.toString());
      received.push(frame);
      if (frame.type === 'register') peer.send(encodeControllerMessage({ version: CONTROLLER_PROTOCOL_MAJOR, type: 'registered', minor }));
    });
  });
  await new Promise<void>(resolve => server.listen(endpoint, resolve));
  cleanups.push(async () => { for (const peer of peers) peer.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const source: ControllerNotificationSource = {
    current: () => current,
    subscribe(listener) { arrivals.add(listener); return () => { arrivals.delete(listener); }; },
    subscribeCurrent(listener) { changes.add(listener); return () => { changes.delete(listener); }; },
  };
  const stop = registerControllerTerminal(home, { launchDirectory: '/fixed/worktree', repositoryRoot: '/repo' }, () => 'activated', () => {},
    listener => { status = listener; listener(workStatus()); return () => {}; }, () => {}, source);
  cleanups.push(stop);
  await expect.poll(() => received.filter(frame => frame.type === 'status').length).toBe(1);
  async function flush() {
    const before = received.filter(frame => frame.type === 'status').length;
    status!(workStatus({ error: { reason: 'transport barrier' } }));
    await expect.poll(() => received.filter(frame => frame.type === 'status').length).toBe(before + 1);
  }
  return { received, change(notification: NotificationCondition | null) { current = notification; for (const listener of changes) listener(notification); }, emit(notification: NotificationCondition) { for (const listener of arrivals) listener(notification); }, flush };
}

it('publishes every distinct arrival in order independently of status coalescing', async () => {
  const h = await connect(2, null);
  expect.soft(h.received.find(frame => frame.type === 'register')).toMatchObject({ version: 2, minor: CONTROLLER_PROTOCOL_MINOR });
  const notifications = ['first', 'second', 'third'].map((message, index) => ({ conditionId: `stop-${index}`, message }));
  for (const notification of notifications) h.emit(notification);
  await h.flush();
  expect(h.received.filter(frame => frame.type === 'notification').map(frame => frame.notification)).toEqual(notifications);
});

it.each([null, { conditionId: 'current-stop', message: 'Approve current release' }])('publishes authoritative current condition %j on registration', async current => {
  const h = await connect(2, current);
  await h.flush();
  expect(h.received.filter(frame => frame.type === 'notification-current')).toEqual([{ version: 2, type: 'notification-current', notification: current }]);
});

it.each([0, 1, undefined])('keeps legacy minor %s connected without sending notification extensions', async minor => {
  const h = await connect(minor, { conditionId: 'current-stop', message: 'Approve' });
  h.emit({ conditionId: 'next-stop', message: 'Next approval' });
  await h.flush();
  expect(h.received.filter(frame => !['register', 'status'].includes(String(frame.type)))).toEqual([]);
  expect(h.received.filter(frame => frame.type === 'status')).toHaveLength(2);
});

it('publishes current-condition changes and resolution without creating notification arrivals', async () => {
  const first = { conditionId: 'first', message: 'First pending request' };
  const next = { conditionId: 'next', message: 'Next current request' };
  const h = await connect(2, first);
  h.change(next); await h.flush();
  h.change(null); await h.flush();
  expect(h.received.filter(frame => frame.type === 'notification-current').map(frame => frame.notification)).toEqual([first, next, null]);
  expect(h.received.filter(frame => frame.type === 'notification')).toEqual([]);
});
