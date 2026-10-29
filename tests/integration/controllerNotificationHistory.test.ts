import { clearObserved } from '../helpers/controllerClear';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type WebSocket from 'ws';
import { startControllerTransport } from '../../src/main/controllerTransport';
import { resolveControllerEndpoint } from '../../src/main/controllerEndpoint';
import { directoryCards } from '../../src/shared/controllerCards';
import type { NotificationCondition } from '../../src/shared/controllerProtocol';
import { connectWebSocket } from '../helpers/controllerWebSocket';
import { workStatus } from '../helpers/controllerStatusFixture';
import { notificationEntries, type HistoryTerminal } from '../helpers/controllerHistory';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const condition = (message: string): NotificationCondition => ({ conditionId: `condition-${message}`, message });
const entry = (message: string, receivedAt: number, count = 1) => ({ message, receivedAt, count });

async function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'at-hist-')));
  let registry = await startControllerTransport(home);
  const peers = new Set<WebSocket>();
  let clock = 1000;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  cleanups.push(async () => {
    for (const peer of peers) peer.terminate();
    await registry.dispose();
    rmSync(home, { recursive: true, force: true });
  });
  const terminal = (directory = '/work/a') => registry.terminals().find(t => t.launchDirectory === directory) as HistoryTerminal | undefined;
  async function connect(directory = '/work/a', current: NotificationCondition | null = null) {
    const peer = connectWebSocket(resolveControllerEndpoint(home));
    peers.add(peer);
    await once(peer, 'open');
    const registered = once(peer, 'message');
    peer.send(JSON.stringify({ version: 2, minor: 1, type: 'register', launchDirectory: directory, repositoryRoot: '/work' }));
    await registered;
    const id = registry.terminals().filter(t => t.launchDirectory === directory && t.status !== 'disconnected').at(-1)!.id;
    let revision = 0;
    async function flush(attention: ReturnType<typeof workStatus>['attention'] = null, error: ReturnType<typeof workStatus>['error'] = null) {
      const step = `barrier-${++revision}`;
      peer.send(JSON.stringify({ version: 2, type: 'status', work: workStatus({ attention, error, flow: { availability: 'known', name: 'history', step, assignment: 'assigned' } }) }));
      await expect.poll(() => registry.terminals().find(t => t.id === id)?.work?.flow).toMatchObject({ step });
    }
    async function report(value: NotificationCondition | null) {
      peer.send(JSON.stringify({ version: 2, type: 'notification-current', notification: value }));
      await flush();
    }
    await report(current);
    return {
      id, flush, report,
      async arrival(message: string) {
        peer.send(JSON.stringify({ version: 2, type: 'notification', notification: condition(message) }));
        await flush();
      },
      async close() {
        const closed = once(peer, 'close');
        peer.close(); await closed;
        await expect.poll(() => registry.terminals().filter(t => t.id === id && t.status !== 'disconnected')).toEqual([]);
      },
    };
  }
  return {
    files: () => readdirSync(home, { recursive: true }).sort(),
    connect, terminal, entries: (directory?: string) => notificationEntries(terminal(directory)),
    time(value: number) { clock = value; },
    registry: () => registry,
    async restart() {
      for (const peer of peers) peer.terminate();
      peers.clear();
      await registry.dispose();
      registry = await startControllerTransport(home);
    },
  };
}

it('retains the newest three distinct arrivals, including equal-time arrivals, independently per worktree', async () => {
  const h = await fixture();
  const a = await h.connect(); const b = await h.connect('/work/b');
  await b.arrival('other');
  for (const message of ['one', 'two', 'three', 'four']) await a.arrival(message);
  expect.soft(h.entries()).toEqual([entry('four', 1000), entry('three', 1000), entry('two', 1000)]);
  expect.soft(h.entries('/work/b')).toEqual([entry('other', 1000)]);
});

it('counts exact-text repeats without reordering, retiming or eviction, and forgets evicted text', async () => {
  const h = await fixture(); const a = await h.connect();
  await a.arrival('A'); h.time(2000); await a.arrival('B');
  h.time(3000); await a.arrival('A');
  expect.soft(h.entries()).toEqual([entry('B', 2000), entry('A', 1000, 2)]);
  await a.arrival(' A'); h.time(4000); await a.arrival('C');
  expect.soft(h.entries()).toEqual([entry('C', 4000), entry(' A', 3000), entry('B', 2000)]);
  h.time(5000); await a.arrival('A');
  expect.soft(h.entries()).toEqual([entry('A', 5000), entry('C', 4000), entry(' A', 3000)]);
});

it('keeps original receipt after the gate ends and ignores ordinary status and unchanged current refreshes', async () => {
  const h = await fixture(); const a = await h.connect('/work/a', condition('pending'));
  h.time(9000);
  await a.flush({ status: 'complete', reasons: ['still pending'] });
  await a.report(condition('pending')); await a.report(null); await a.flush();
  expect.soft(h.entries()).toEqual([entry('pending', 1000)]);
  expect.soft(h.terminal()?.work?.attention).toBeNull();
});

it('projects disconnected history without exposing stale live work, and reuses it on same-run reconnect', async () => {
  const h = await fixture(); const a = await h.connect('/work/a', condition('pending'));
  await a.arrival('older context');
  await a.close();
  const card = directoryCards(h.registry().terminals())[0];
  expect.soft(card).toMatchObject({ kind: 'disconnected', notifications: [entry('older context', 1000), entry('pending', 1000)] });
  expect.soft('work' in card ? card.work : undefined).toBeUndefined();
  h.time(9000); await h.connect('/work/a', condition('pending'));
  expect.soft(h.entries()).toEqual([entry('older context', 1000), entry('pending', 1000, 2)]);
  expect.soft(h.terminal()?.status).not.toBe('disconnected');
});

it('reconnect with no current condition preserves history without reviving ended attention', async () => {
  const h = await fixture(); const a = await h.connect('/work/a', condition('ended'));
  await a.close(); h.time(9000); await h.connect('/work/a', null);
  expect.soft(h.entries()).toEqual([entry('ended', 1000)]);
  expect.soft(h.terminal()?.work?.attention).toBeNull();
});

it.each(['restart', 'dismiss'] as const)('%s forgets entries and counts; a current request is received afresh', async reset => {
  const h = await fixture(); const a = await h.connect('/work/a', condition('pending'));
  await a.arrival('pending'); await a.arrival('old'); await a.close();
  if (reset === 'restart') await h.restart(); else h.registry().dismiss(a.id);
  expect.soft(h.registry().terminals()).toEqual([]);
  h.time(9000); const replacement = await h.connect('/work/a', condition('pending'));
  expect.soft(h.entries()).toEqual([entry('pending', 9000)]);
  h.registry().dismiss(a.id);
  expect.soft(h.terminal()?.id).toBe(replacement.id);
  expect.soft(h.entries()).toEqual([entry('pending', 9000)]);
});

it.each(['restart', 'dismiss'] as const)('%s with no current request restores no deleted history', async reset => {
  const h = await fixture(); const a = await h.connect('/work/a', condition('ended'));
  await a.close();
  if (reset === 'restart') await h.restart(); else h.registry().dismiss(a.id);
  await h.connect('/work/a', null);
  expect(h.entries()).toEqual([]);
  expect(h.terminal()?.latestNotification).toBeUndefined();
});

it.each([true, false])('overlap discards all history and rebuilds only the current survivor (current=%s)', async pending => {
  const h = await fixture(); const a = await h.connect('/work/a', condition('old'));
  const other = await h.connect('/work/b', condition('unrelated'));
  const b = await h.connect('/work/a', condition('peer'));
  await a.arrival('transient overlap');
  await a.report(pending ? condition('survivor now') : null);
  expect.soft(h.registry().terminals().filter(t => t.launchDirectory === '/work/a').flatMap(t => notificationEntries(t))).toEqual([]);
  h.time(9000); await b.close(); await a.flush();
  expect.soft(h.entries()).toEqual(pending ? [entry('survivor now', 9000)] : []);
  expect.soft(h.entries('/work/b')).toEqual([entry('unrelated', 1000)]);
  await other.flush();
});

it('does not let a consumer mutate retained history or another subscriber snapshot', async () => {
  const h = await fixture(); const a = await h.connect(); await a.arrival('original');
  const snapshot = h.terminal();
  if (snapshot?.notifications?.[0]) snapshot.notifications[0].message = 'corrupted';
  const stop = h.registry().subscribeTerminals(values => {
    const first = notificationEntries(values[0])[0];
    if (first) first.count = 999;
  });
  await a.flush(); stop();
  expect(h.entries()).toEqual([entry('original', 1000)]);
});

it('empty current reports during overlap cannot resurrect a transient event after both peers leave', async () => {
  const h = await fixture(); const a = await h.connect('/work/a', condition('before overlap'));
  const b = await h.connect('/work/a', condition('peer before'));
  await a.arrival('transient A'); await b.arrival('transient B');
  await a.report(null); await b.report(null);
  await Promise.all([a.close(), b.close()]);
  expect.soft(h.entries()).toEqual([]);
  expect.soft(directoryCards(h.registry().terminals())[0]).toMatchObject({ kind: 'disconnected' });
});

it('notification arrival creates no saved feature files under the controller home', async () => {
  const h = await fixture(); const a = await h.connect();
  const before = h.files();
  await a.arrival('first'); await a.arrival('second'); await a.close();
  expect(h.files()).toEqual(before);
});

for (const disconnected of [false, true]) {
  it(`clears every entry and repeat count while preserving ${disconnected ? 'disconnected' : 'live'} card and other directories`, async () => {
    const h = await fixture(); const a = await h.connect(); const b = await h.connect('/work/b');
    await a.arrival('one'); await a.arrival('two'); await a.arrival('one'); await b.arrival('unrelated');
    await a.flush({ status: 'complete', reasons: ['Real current reason'] }, { reason: 'Actual live failure' });
    if (disconnected) await a.close();
    const before = h.terminal()!; const other = h.terminal('/work/b');
    const result = await clearObserved(h.registry(), before);
    expect.soft(h.entries()).toEqual([]);
    expect.soft(h.terminal()?.latestNotification).toBeUndefined();
    expect.soft(result).toBe('cleared');
    expect.soft(h.terminal()?.id).toBe(before.id);
    expect.soft(h.terminal()?.status).toBe(before.status);
    expect.soft(h.terminal()?.work).toEqual(before.work);
    expect.soft(h.terminal('/work/b')).toEqual(other);
  });
}


it.each(['arrival', 'repeat', 'disconnect', 'replacement', 'overlap', 'dismiss'] as const)('refuses an observed Clear after %s and permits fresh explicit retry', async change => {
  const h = await fixture(); const a = await h.connect();
  await a.arrival('original');
  const b = await h.connect('/work/b'); await b.arrival('unrelated');
  const observed = h.terminal()!;
  if (change === 'arrival') await a.arrival('new protected message');
  if (change === 'repeat') await a.arrival('original');
  if (change === 'disconnect' || change === 'replacement' || change === 'dismiss') await a.close();
  if (change === 'replacement') await h.connect('/work/a', condition('replacement'));
  if (change === 'overlap') await h.connect('/work/a', condition('overlapping'));
  if (change === 'dismiss') h.registry().dismiss(a.id);
  const before = h.registry().terminals();
  expect.soft(await clearObserved(h.registry(), observed)).toBe('stale');
  expect.soft(h.registry().terminals()).toEqual(before);
  if (change === 'overlap') await a.close();
  if (change === 'dismiss') await h.connect('/work/a', condition('fresh after dismissal'));
  const current = h.terminal()!;
  expect.soft(await clearObserved(h.registry(), current)).toBe('cleared');
  expect.soft(h.entries()).toEqual([]);
  expect.soft(h.terminal('/work/b')).toEqual(before.find(t => t.id === b.id));
});

it('an unrelated live-status update does not invalidate observed Clear or remove the updated live condition', async () => {
  const h = await fixture(); const a = await h.connect(); await a.arrival('original');
  const observed = h.terminal()!;
  await a.flush({ status: 'complete', reasons: ['Still requires approval'] }, { reason: 'New live failure' });
  const work = h.terminal()!.work;
  expect.soft(await clearObserved(h.registry(), observed)).toBe('cleared');
  expect.soft(h.entries()).toEqual([]);
  expect.soft(h.terminal()!.work).toEqual(work);
});

it('refuses an old Clear when overlap rebuilds identical history at the same receipt time', async () => {
  const h = await fixture(); const a = await h.connect();
  await a.arrival('same current reason');
  const observed = h.terminal()!;
  const peer = await h.connect('/work/a');
  await peer.close();
  expect(h.entries()).toEqual(observed.notifications);
  expect.soft(await clearObserved(h.registry(), observed)).toBe('stale');
  expect.soft(h.entries()).toEqual(observed.notifications);
  expect.soft(await clearObserved(h.registry(), h.terminal()!)).toBe('cleared');
  expect.soft(h.entries()).toEqual([]);
});
