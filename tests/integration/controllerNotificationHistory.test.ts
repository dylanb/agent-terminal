import { CONTROLLER_PROTOCOL_MAJOR, CONTROLLER_PROTOCOL_MINOR, encodeControllerMessage } from '../../src/shared/controllerProtocol';
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
import { notificationEntries, statusEntries, timelineOf, type HistoryTerminal } from '../helpers/controllerHistory';

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
    peer.send(encodeControllerMessage({ version: CONTROLLER_PROTOCOL_MAJOR, minor: CONTROLLER_PROTOCOL_MINOR, type: 'register', launchDirectory: directory, repositoryRoot: '/work' }));
    await registered;
    const id = registry.terminals().filter(t => t.launchDirectory === directory && t.status !== 'disconnected').at(-1)!.id;
    let revision = 0;
    let activity: ReturnType<typeof workStatus>['activity'] = 'active';
    async function flush(attention: ReturnType<typeof workStatus>['attention'] = null, error: ReturnType<typeof workStatus>['error'] = null) {
      const number = 1000 + ++revision;
      peer.send(encodeControllerMessage({ version: CONTROLLER_PROTOCOL_MAJOR, type: 'status', work: workStatus({ activity, attention, error, ticket: { availability: 'known', number, title: { availability: 'loading' } } }) }));
      await expect.poll(() => registry.terminals().find(t => t.id === id)?.work?.ticket).toMatchObject({ number });
    }
    async function report(value: NotificationCondition | null) {
      peer.send(encodeControllerMessage({ version: CONTROLLER_PROTOCOL_MAJOR, type: 'notification-current', notification: value }));
      await flush();
    }
    await report(current);
    return {
      id, flush, report,
      async setActivity(next: typeof activity) { activity = next; await flush(); },
      async arrival(message: string, conditionId = `condition-${message}`) {
        peer.send(encodeControllerMessage({ version: CONTROLLER_PROTOCOL_MAJOR, type: 'notification', notification: { conditionId, message } }));
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

const shape = (items: ReturnType<typeof timelineOf>) => items.map(item => item.kind === 'notification'
  ? { kind: item.kind, message: item.message, receivedAt: item.receivedAt, count: item.count }
  : { kind: item.kind, receivedAt: item.receivedAt });

it('an exact-text repeat counts in place, keeping its position and receipt time, even with a status entry above it', async () => {
  const h = await fixture(); const a = await h.connect();
  await a.arrival('A');
  h.time(2000); await a.setActivity('quiet');
  h.time(3000); await a.arrival('A');
  expect(shape(timelineOf(h.terminal()))).toEqual([
    { kind: 'status', receivedAt: 2000 },
    { kind: 'notification', message: 'A', receivedAt: 1000, count: 2 },
  ]);
});

it('two identical status changes are two entries, not a counted repeat', async () => {
  const h = await fixture(); const a = await h.connect();
  h.time(2000); await a.setActivity('quiet');
  h.time(3000); await a.setActivity('active');
  h.time(4000); await a.setActivity('quiet');
  const texts = statusEntries(h.terminal());
  expect.soft(texts.map(item => item.receivedAt)).toEqual([4000, 3000, 2000]);
  expect.soft(texts[0]?.text).toBe(texts[2]?.text);
  expect.soft(texts[1]?.text).not.toBe(texts[0]?.text);
  expect.soft(notificationEntries(h.terminal())).toEqual([]);
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
  expect.soft(card).toMatchObject({ kind: 'disconnected' });
  expect.soft(notificationEntries(card)).toEqual([entry('older context', 1000), entry('pending', 1000)]);
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
  expect(timelineOf(h.terminal())[0]).toBeUndefined();
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
  const held = snapshot?.timeline?.[0];
  if (held?.kind === 'notification') held.message = 'corrupted';
  const stop = h.registry().subscribeTerminals(values => {
    const first = values[0]?.timeline?.[0];
    if (first?.kind === 'notification') first.count = 999;
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
    const result = h.registry().clearHistory(before.clearHistoryTarget!);
    expect.soft(h.entries()).toEqual([]);
    expect.soft(timelineOf(h.terminal())).toEqual([]);
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
  expect.soft(h.registry().clearHistory(observed.clearHistoryTarget!)).toBe('stale');
  expect.soft(h.registry().terminals()).toEqual(before);
  if (change === 'overlap') await a.close();
  if (change === 'dismiss') await h.connect('/work/a', condition('fresh after dismissal'));
  const current = h.terminal()!;
  expect.soft(h.registry().clearHistory(current.clearHistoryTarget!)).toBe('cleared');
  expect.soft(h.entries()).toEqual([]);
  expect.soft(h.terminal('/work/b')).toEqual(before.find(t => t.id === b.id));
});

it('a status update that changes no tracked dimension does not invalidate observed Clear or remove the updated live condition', async () => {
  const h = await fixture(); const a = await h.connect(); await a.arrival('original');
  const observed = h.terminal()!;
  await a.flush(null, null);
  const work = h.terminal()!.work;
  expect.soft(h.registry().clearHistory(observed.clearHistoryTarget!)).toBe('cleared');
  expect.soft(h.entries()).toEqual([]);
  expect.soft(h.terminal()!.work).toEqual(work);
});

it('refuses an old Clear when overlap rebuilds identical history at the same receipt time', async () => {
  const h = await fixture(); const a = await h.connect();
  await a.arrival('same current reason');
  const observed = h.terminal()!;
  const peer = await h.connect('/work/a');
  await peer.close();
  expect(h.entries()).toEqual(notificationEntries(observed));
  expect.soft(h.registry().clearHistory(observed.clearHistoryTarget!)).toBe('stale');
  expect.soft(h.entries()).toEqual(notificationEntries(observed));
  expect.soft(h.registry().clearHistory(h.terminal()!.clearHistoryTarget!)).toBe('cleared');
  expect.soft(h.entries()).toEqual([]);
});

for (const disconnected of [false, true]) {
  it(`Clear of a ${disconnected ? 'disconnected' : 'connected'} card survives repeated unchanged recovery but permits a new same-word stop`, async () => {
    const h = await fixture(); const pending = condition('approval');
    const a = await h.connect('/work/a', pending);
    const other = await h.connect('/work/b', condition('unrelated'));
    const otherBefore = h.terminal('/work/b');
    if (disconnected) await a.close();
    expect(h.registry().clearHistory(h.terminal()!.clearHistoryTarget!)).toBe('cleared');
    expect(h.entries()).toEqual([]);
    if (!disconnected) {
      await a.report(pending); await a.flush({ status: 'complete', reasons: ['Still pending'] });
      expect.soft(h.entries()).toEqual([]);
      await a.close();
    }
    h.time(2000); const b = await h.connect('/work/a', pending);
    await b.flush({ status: 'complete', reasons: ['Still pending'] }, { reason: 'Live error remains' });
    expect.soft(h.entries()).toEqual([]);
    expect.soft(h.terminal()?.work).toMatchObject({ attention: { reasons: ['Still pending'] }, error: { reason: 'Live error remains' } });
    await b.close(); h.time(3000); const c = await h.connect('/work/a', pending);
    expect.soft(h.entries()).toEqual([]);
    expect(h.registry().clearHistory(h.terminal()!.clearHistoryTarget!)).toBe('cleared');
    await c.arrival('approval', 'new-qualifying-stop');
    expect.soft(h.entries()).toEqual([entry('approval', 3000)]);
    expect.soft(h.terminal('/work/b')).toEqual(otherBefore);
    await other.flush();
  });
}

it('an ended cleared condition stays absent on recovery, while a new offline same-word stop is received', async () => {
  const h = await fixture(); const a = await h.connect('/work/a', condition('approval'));
  expect(h.registry().clearHistory(h.terminal()!.clearHistoryTarget!)).toBe('cleared');
  await a.report(null); await a.close();
  const b = await h.connect('/work/a', null);
  expect.soft(h.entries()).toEqual([]);
  expect.soft(h.terminal()?.work?.attention).toBeNull();
  await b.close(); h.time(9000);
  await h.connect('/work/a', { conditionId: 'new-offline-stop', message: 'approval' });
  expect.soft(h.entries()).toEqual([entry('approval', 9000)]);
});

for (const reset of ['restart', 'dismiss', 'overlap'] as const) for (const pending of [true, false]) {
  it(`${reset} forgets Clear suppression and rebuilds solely from current information (pending=${pending})`, async () => {
    const h = await fixture(); const current = condition('approval');
    const a = await h.connect('/work/a', current);
    await a.arrival('approval'); await a.arrival('old context'); await a.report(current);
    expect(h.registry().clearHistory(h.terminal()!.clearHistoryTarget!)).toBe('cleared');
    const other = await h.connect('/work/b', condition('unrelated'));
    const otherBefore = h.terminal('/work/b');
    const next = pending ? current : null;
    if (reset === 'overlap') {
      const peer = await h.connect('/work/a', condition('overlap-only'));
      await peer.arrival('discarded overlap'); await a.report(next);
      expect.soft(h.registry().terminals().filter(t => t.launchDirectory === '/work/a').flatMap(notificationEntries)).toEqual([]);
      h.time(9000); await peer.close(); await a.flush();
    } else {
      await a.close();
      if (reset === 'restart') await h.restart(); else h.registry().dismiss(a.id);
      expect.soft(h.terminal()).toBeUndefined();
      h.time(9000); await h.connect('/work/a', next);
    }
    expect.soft(h.entries()).toEqual(pending ? [entry('approval', 9000)] : []);
    if (reset !== 'restart') {
      expect.soft(h.terminal('/work/b')).toEqual(otherBefore);
      await other.flush();
    } else expect.soft(h.terminal('/work/b')).toBeUndefined();
  });
}

it('overlap ending with no current survivor forgets Clear before a later fresh connection', async () => {
  const h = await fixture(); const current = condition('approval');
  const a = await h.connect('/work/a', current);
  expect(h.registry().clearHistory(h.terminal()!.clearHistoryTarget!)).toBe('cleared');
  const b = await h.connect('/work/a', condition('peer'));
  await a.report(null); await b.report(null);
  await Promise.all([a.close(), b.close()]);
  expect.soft(h.entries()).toEqual([]);
  h.time(9000); await h.connect('/work/a', current);
  expect.soft(h.entries()).toEqual([entry('approval', 9000)]);
});

it.each(['dismiss', 'overlap'] as const)('%s forgets only its own Clear suppression, leaving another cleared directory suppressed through reconnect', async reset => {
  const h = await fixture(); const selected = condition('selected approval'); const unrelated = condition('unrelated approval');
  const a = await h.connect('/work/a', selected); const b = await h.connect('/work/b', unrelated);
  expect(h.registry().clearHistory(h.terminal('/work/a')!.clearHistoryTarget!)).toBe('cleared');
  expect(h.registry().clearHistory(h.terminal('/work/b')!.clearHistoryTarget!)).toBe('cleared');
  expect(h.entries('/work/a')).toEqual([]); expect(h.entries('/work/b')).toEqual([]);
  h.time(9000);
  if (reset === 'dismiss') {
    await a.close(); h.registry().dismiss(a.id); await h.connect('/work/a', selected);
  } else {
    const peer = await h.connect('/work/a', condition('overlapping request'));
    await peer.close(); await a.flush();
  }
  expect.soft(h.entries('/work/a')).toEqual([entry('selected approval', 9000)]);
  await b.close(); await h.connect('/work/b', unrelated);
  expect.soft(h.entries('/work/b')).toEqual([]);
  expect.soft(h.entries('/work/a')).toEqual([entry('selected approval', 9000)]);
});

it('publishes notification content only through retained entries in snapshots and cards', async () => {
  const h = await fixture();
  const peer = await h.connect();
  await peer.arrival('one');
  const published = h.terminal()!;
  expect.soft(published.timeline).toEqual([{ kind: 'notification', ...entry('one', 1000) }]);
  expect.soft(published).not.toHaveProperty('notifications');
  expect.soft(published).not.toHaveProperty('latestNotification');
  const card = directoryCards([published])[0];
  expect.soft(card).toMatchObject({ timeline: [{ kind: 'notification', ...entry('one', 1000) }] });
  expect.soft(card).not.toHaveProperty('notifications');
  expect(card).not.toHaveProperty('latestNotification');
});

it('publishes a dedicated Clear target without live work or message content', async () => {
  const h = await fixture(); const peer = await h.connect();
  expect(h.terminal()).not.toHaveProperty('clearHistoryTarget');
  await peer.arrival('approval');
  const snapshot = h.terminal()!;
  const target = { id: expect.any(String), launchDirectory: '/work/a', revision: expect.any(String) };
  expect.soft(snapshot).toHaveProperty('clearHistoryTarget', target);
  expect.soft(snapshot).not.toHaveProperty('notificationVersion');
  expect(directoryCards([snapshot])[0]).toHaveProperty('clearHistoryTarget', target);
});
