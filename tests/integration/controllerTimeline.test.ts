import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startControllerTransport } from '../../src/main/controllerTransport';
import { CONTROLLER_LOOP_MESSAGE_MINOR, CONTROLLER_MAX_STATUS_BYTES, CONTROLLER_PROTOCOL_MAJOR, encodeControllerMessage, type NotificationCondition } from '../../src/shared/controllerProtocol';
import type { ControllerWorkStatus } from '../../src/shared/ipc';
import { connectScriptedTerminal, type ScriptedControllerTerminal } from '../helpers/scriptedControllerTerminal';
import { workStatus } from '../helpers/controllerStatusFixture';
import { statusEntries, timelineOf } from '../helpers/controllerHistory';
import { directoryCards } from '../../src/shared/controllerCards';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const DIRECTORY = '/work/timeline';
const request: NotificationCondition = { conditionId: 'stop-1', message: 'Approve the plan before the build' };
const attention = { status: 'complete', reasons: ['Approve the plan before the build'] };

async function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'at-timeline-')));
  let registry = await startControllerTransport(home);
  let clock = 500;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  const terminals = new Set<ScriptedControllerTerminal>();
  cleanups.push(async () => {
    for (const terminal of terminals) await terminal.close();
    await registry.dispose();
    rmSync(home, { recursive: true, force: true });
  });
  const shown = (directory = DIRECTORY) => registry.terminals().filter(t => t.launchDirectory === directory);
  const card = (directory = DIRECTORY) => directoryCards(registry.terminals()).find(c => c.launchDirectory === directory);
  async function connect(minor?: number, directory = DIRECTORY) {
    const terminal = await connectScriptedTerminal(home, { launchDirectory: directory, repositoryRoot: '/work' }, minor);
    terminals.add(terminal);
    let revision = 0;
    async function report(overrides: Parameters<typeof workStatus>[0] = {}) {
      const number = 7000 + ++revision;
      await terminal.sendStatus(workStatus({ ...overrides, ticket: { availability: 'known', number, title: { availability: 'loading' } } }));
      await expect.poll(() => shown(directory).find(t => t.status !== 'disconnected')?.work?.ticket).toMatchObject({ number });
    }
    return { terminal, report };
  }
  return {
    connect, shown, card,
    timeline: (directory = DIRECTORY) => timelineOf(card(directory)),
    time(value: number) { clock = value; },
    registry: () => registry,
    async restart() {
      for (const terminal of terminals) await terminal.close();
      terminals.clear();
      await registry.dispose();
      registry = await startControllerTransport(home);
    },
  };
}

const brief = (items: ReturnType<typeof timelineOf>) => items.map(item => ({ kind: item.kind, receivedAt: item.receivedAt }));

it.each(['notification first', 'status first'] as const)('a request raised after an idle change is one entry above the idle entry (%s)', async order => {
  const h = await fixture(); const { terminal, report } = await h.connect();
  await terminal.reportCurrent(null);
  await report({ activity: 'active' });
  h.time(2000); await report({ activity: 'quiet' });
  h.time(3000);
  if (order === 'notification first') {
    await terminal.raise(request);
    await report({ activity: 'quiet', attention });
  } else {
    await report({ activity: 'quiet', attention });
    await terminal.raise(request);
    await report({ activity: 'quiet', attention });
  }
  const items = h.timeline();
  expect.soft(items).toHaveLength(2);
  expect.soft(brief(items)[0]?.receivedAt).toBe(3000);
  expect.soft(items[1]).toEqual({ kind: 'status', text: expect.stringContaining('Idle'), receivedAt: 2000 });
  if (order === 'notification first') expect.soft(items[0]).toEqual({ kind: 'notification', message: request.message, receivedAt: 3000, count: 1 });
  expect.soft(items.filter(item => item.kind === 'notification' && item.message === request.message).length).toBeLessThanOrEqual(1);
});

it('a request whose notification arrives before a status that also changes activity stays the newest entry', async () => {
  const h = await fixture(); const { terminal, report } = await h.connect();
  await terminal.reportCurrent(null);
  await report({ activity: 'active' });
  h.time(3000);
  await terminal.raise(request);
  await report({ activity: 'quiet', attention });
  const items = h.timeline();
  expect.soft(items[0]).toEqual({ kind: 'notification', message: request.message, receivedAt: 3000, count: 1 });
  expect.soft(items[1]).toEqual({ kind: 'status', text: expect.stringContaining('Idle'), receivedAt: 3000 });
});

it('a request that clears through status alone and is re-raised as the current request is a new entry above the clearing', async () => {
  const h = await fixture(); const { terminal, report } = await h.connect();
  await terminal.reportCurrent(null);
  await report({ activity: 'quiet' });
  h.time(1000); await terminal.raise(request); await report({ activity: 'quiet', attention });
  h.time(2000); await report({ activity: 'quiet' });
  h.time(3000); await terminal.reportCurrent(request); await report({ activity: 'quiet', attention });
  const items = h.timeline();
  expect.soft(items[0]?.receivedAt).toBe(3000);
  expect.soft(items[1]).toEqual({ kind: 'status', text: expect.stringContaining('cleared'), receivedAt: 2000 });
});

it('an older terminal without notification support gets one condition entry for the same request', async () => {
  const h = await fixture(); const { report } = await h.connect(CONTROLLER_LOOP_MESSAGE_MINOR);
  await report({ activity: 'quiet' });
  h.time(3000); await report({ activity: 'quiet', attention });
  expect(h.timeline()).toEqual([{ kind: 'status', text: expect.any(String), receivedAt: 3000 }]);
  await report({ activity: 'quiet', attention: { ...attention, reasons: ['Approve the plan before the build', 'and the budget'] } });
  expect(brief(h.timeline())).toEqual([{ kind: 'status', receivedAt: 3000 }]);
});

it('an older terminal reconnecting with its request still current adds no second request entry', async () => {
  const h = await fixture(); const first = await h.connect(CONTROLLER_LOOP_MESSAGE_MINOR);
  await first.report({ activity: 'quiet' });
  h.time(3000); await first.report({ activity: 'quiet', attention });
  h.time(4000); await first.terminal.close();
  await expect.poll(() => h.card()?.kind).toBe('disconnected');
  const retained = h.timeline();
  h.time(5000);
  const again = await h.connect(CONTROLLER_LOOP_MESSAGE_MINOR);
  await again.report({ activity: 'quiet', attention });
  expect(h.timeline()).toEqual(retained);
});

it('an older terminal reconnecting with a request the operator cleared does not bring it back', async () => {
  const h = await fixture(); const first = await h.connect(CONTROLLER_LOOP_MESSAGE_MINOR);
  await first.report({ activity: 'quiet' });
  h.time(3000); await first.report({ activity: 'quiet', attention });
  expect.soft(h.registry().clearHistory(h.shown()[0].clearHistoryTarget!)).toBe('cleared');
  await first.terminal.close();
  await expect.poll(() => h.card()?.kind).toBe('disconnected');
  h.time(5000);
  const again = await h.connect(CONTROLLER_LOOP_MESSAGE_MINOR);
  await again.report({ activity: 'quiet', attention });
  expect(h.timeline().filter(item => item.receivedAt === 5000)).toEqual([]);
});

it('a request that clears and is raised again with identical text is a new entry above the cleared entry, leaving the first notification entry in place', async () => {
  const h = await fixture(); const { terminal, report } = await h.connect();
  await terminal.reportCurrent(null);
  await report({ activity: 'quiet' });
  h.time(1000); await terminal.raise(request); await report({ activity: 'quiet', attention });
  h.time(2000); await terminal.reportCurrent(null); await report({ activity: 'quiet' });
  h.time(3000); await terminal.raise(request); await report({ activity: 'quiet', attention });
  const items = h.timeline();
  expect.soft(brief(items)).toEqual([
    { kind: 'status', receivedAt: 3000 },
    { kind: 'status', receivedAt: 2000 },
    { kind: 'notification', receivedAt: 1000 },
  ]);
  expect.soft(items[2]).toMatchObject({ message: request.message, receivedAt: 1000 });
  expect.soft(statusEntries(h.card())[0]?.text).not.toBe(statusEntries(h.card())[1]?.text);
});

it('records Disconnected when the last connection leaves, and nothing when one of two leaves', async () => {
  const h = await fixture(); const first = await h.connect(undefined, '/work/solo');
  await first.report({ activity: 'quiet' });
  h.time(4000); await first.terminal.close();
  await expect.poll(() => h.card('/work/solo')?.kind).toBe('disconnected');
  const items = h.timeline('/work/solo');
  expect.soft(items[0]).toEqual({ kind: 'status', text: expect.stringContaining('Disconnected'), receivedAt: 4000 });

  const a = await h.connect(undefined, '/work/pair'); const b = await h.connect(undefined, '/work/pair');
  await a.report({ activity: 'quiet' });
  h.time(5000); await b.terminal.close();
  await expect.poll(() => h.shown('/work/pair').filter(t => t.status !== 'disconnected').length).toBe(1);
  await a.report({ activity: 'active' });
  expect(h.timeline('/work/pair').some(item => item.kind === 'status' && item.text.includes('Disconnected'))).toBe(false);
});

it('the first status after an overlap ends is a baseline for the survivor', async () => {
  const h = await fixture();
  const a = await h.connect(undefined, '/work/overlap'); const b = await h.connect(undefined, '/work/overlap');
  await a.report({ activity: 'quiet' });
  await b.terminal.close();
  await expect.poll(() => h.shown('/work/overlap').filter(t => t.status !== 'disconnected').length).toBe(1);
  await a.report({ activity: 'active' });
  expect.soft(statusEntries(h.card('/work/overlap'))).toEqual([]);
  h.time(6000); await a.report({ activity: 'quiet' });
  expect.soft(statusEntries(h.card('/work/overlap')).map(item => item.receivedAt)).toEqual([6000]);
});

it('changes reported during an overlap leave no entry on the survivor\'s card', async () => {
  const h = await fixture();
  const a = await h.connect(undefined, '/work/overlap'); const b = await h.connect(undefined, '/work/overlap');
  await a.report({ activity: 'active' });
  h.time(2000); await a.report({ activity: 'quiet' });
  await b.terminal.close();
  await expect.poll(() => h.shown('/work/overlap').filter(t => t.status !== 'disconnected').length).toBe(1);
  expect(statusEntries(h.card('/work/overlap'))).toEqual([]);
});

it('a notification whose text matches a status entry is a new entry, not a counted repeat', async () => {
  const h = await fixture(); const { terminal, report } = await h.connect();
  await terminal.reportCurrent(null);
  await report({ activity: 'active' });
  h.time(2000); await report({ activity: 'quiet' });
  const [idle] = statusEntries(h.card());
  h.time(3000); await terminal.raise({ conditionId: 'stop-echo', message: idle?.text ?? 'Idle' });
  await expect.poll(() => h.timeline().length).toBe(2);
  expect(h.timeline()[0]).toEqual({ kind: 'notification', message: idle?.text ?? 'Idle', receivedAt: 3000, count: 1 });
});

it('an oversized status report adds no entries and does not count as the request or error clearing', async () => {
  const h = await fixture(); const { terminal, report } = await h.connect();
  await terminal.reportCurrent(null);
  await report({ activity: 'quiet' });
  h.time(2000);
  await terminal.raise(request);
  await report({ activity: 'quiet', attention, error: { reason: 'Build failed' } });
  const before = h.timeline();
  const oversized = JSON.parse(encodeControllerMessage({ version: CONTROLLER_PROTOCOL_MAJOR, type: 'status', work: workStatus({ attention: { status: 'complete', reasons: ['x'.repeat(CONTROLLER_MAX_STATUS_BYTES)] } }) })) as { work: ControllerWorkStatus };
  h.time(3000);
  await terminal.sendStatus(oversized.work);
  await expect.poll(() => h.shown().find(t => t.status !== 'disconnected')?.work?.unavailableReason).toBe('message-too-large');
  expect.soft(h.timeline()).toEqual(before);
  h.time(4000);
  await report({ activity: 'quiet', attention, error: { reason: 'Build failed' } });
  expect.soft(h.timeline()).toEqual(before);
});

it('keeps the three newest of four qualifying changes, newest first', async () => {
  const h = await fixture(); const { report } = await h.connect();
  await report({ activity: 'active' });
  for (const [time, activity] of [[2000, 'quiet'], [3000, 'active'], [4000, 'quiet'], [5000, 'active']] as const) {
    h.time(time); await report({ activity });
  }
  expect(brief(h.timeline())).toEqual([
    { kind: 'status', receivedAt: 5000 }, { kind: 'status', receivedAt: 4000 }, { kind: 'status', receivedAt: 3000 },
  ]);
});

it('bounds notifications and status entries together', async () => {
  const h = await fixture(); const { terminal, report } = await h.connect();
  await terminal.reportCurrent(null);
  await report({ activity: 'active' });
  h.time(2000); await terminal.raise({ conditionId: 'a', message: 'first request' }); await report({ activity: 'active' });
  h.time(3000); await report({ activity: 'quiet' });
  h.time(4000); await terminal.raise({ conditionId: 'b', message: 'second request' }); await report({ activity: 'quiet' });
  h.time(5000); await report({ activity: 'active' });
  expect(brief(h.timeline())).toEqual([
    { kind: 'status', receivedAt: 5000 }, { kind: 'notification', receivedAt: 4000 }, { kind: 'status', receivedAt: 3000 },
  ]);
});

it('a report that changes only the branch, title, ticket, loop message or reasons leaves the timeline unchanged', async () => {
  const h = await fixture(); const { report } = await h.connect();
  await report({ activity: 'active', title: 'T1', branch: 'b1' });
  h.time(2000); await report({ activity: 'quiet', title: 'T1', branch: 'b1' });
  const before = h.timeline();
  expect.soft(before).toHaveLength(1);
  h.time(3000);
  await report({ activity: 'quiet', title: 'T1', branch: 'a-different-branch' });
  await report({ activity: 'quiet', title: 'another title', branch: 'a-different-branch' });
  await report({ activity: 'quiet', title: null, branch: null, loopMessage: { id: 'm', kind: 'notice', reason: 'nothing to commit' } });
  expect(h.timeline()).toEqual(before);
});

it('a changed error text while the error stays present adds nothing, and its appearing and clearing add one entry each', async () => {
  const h = await fixture(); const { report } = await h.connect();
  await report({ activity: 'quiet' });
  h.time(2000); await report({ activity: 'quiet', error: { reason: 'Step exited 1' } });
  expect(brief(h.timeline())).toEqual([{ kind: 'status', receivedAt: 2000 }]);
  h.time(3000); await report({ activity: 'quiet', error: { reason: 'Step exited 2' } });
  expect(brief(h.timeline())).toEqual([{ kind: 'status', receivedAt: 2000 }]);
  h.time(4000); await report({ activity: 'quiet' });
  expect(brief(h.timeline())).toEqual([{ kind: 'status', receivedAt: 4000 }, { kind: 'status', receivedAt: 2000 }]);
});

it('a flow step change adds an entry', async () => {
  const h = await fixture(); const { report } = await h.connect();
  const flow = (step: string) => ({ availability: 'known', name: 'feature-dev', step, assignment: 'assigned' }) as const;
  await report({ flow: flow('plan') });
  h.time(2000); await report({ flow: flow('implement') });
  expect(brief(h.timeline())).toEqual([{ kind: 'status', receivedAt: 2000 }]);
});

it('Clear empties the timeline and keeps the work, and a status change after the snapshot makes it stale', async () => {
  const h = await fixture(); const { report } = await h.connect();
  await report({ activity: 'active' });
  h.time(2000); await report({ activity: 'quiet' });
  const observed = h.shown()[0];
  expect(observed.clearHistoryTarget).toBeDefined();
  h.time(3000); await report({ activity: 'active' });
  expect.soft(h.registry().clearHistory(observed.clearHistoryTarget!)).toBe('stale');
  expect.soft(h.timeline()).toHaveLength(2);
  const fresh = h.shown()[0];
  expect.soft(h.registry().clearHistory(fresh.clearHistoryTarget!)).toBe('cleared');
  expect.soft(h.timeline()).toEqual([]);
  expect.soft(h.shown()[0].work).toEqual(fresh.work);
});

it('a fresh controller holds only the reconnecting terminal\'s current request, with no status entries', async () => {
  const h = await fixture(); const { terminal, report } = await h.connect();
  await terminal.reportCurrent(null);
  await report({ activity: 'active' });
  h.time(2000); await report({ activity: 'quiet' });
  await h.restart();
  h.time(9000);
  const again = await h.connect();
  await again.terminal.reportCurrent(request);
  await again.report({ activity: 'quiet', attention });
  expect(h.timeline()).toEqual([{ kind: 'notification', message: request.message, receivedAt: 9000, count: 1 }]);
});

it('after a restart an older terminal whose baseline status carries the request gets one condition entry', async () => {
  const h = await fixture(); const first = await h.connect(CONTROLLER_LOOP_MESSAGE_MINOR);
  await first.report({ activity: 'active' });
  h.time(2000); await first.report({ activity: 'quiet' });
  await h.restart();
  h.time(9000);
  const again = await h.connect(CONTROLLER_LOOP_MESSAGE_MINOR);
  await again.report({ activity: 'quiet', attention });
  expect(h.timeline()).toEqual([{ kind: 'status', text: expect.any(String), receivedAt: 9000 }]);
});

it('a baseline status adds no activity, error or step entries', async () => {
  const h = await fixture(); const { report } = await h.connect();
  await report({ activity: 'quiet', error: { reason: 'Step exited 1' }, flow: { availability: 'known', name: 'feature-dev', step: 'review', assignment: 'assigned' } });
  expect(h.timeline()).toEqual([]);
});

it('reconnecting adds no connected entry and keeps the retained entries', async () => {
  const h = await fixture(); const first = await h.connect();
  await first.report({ activity: 'active' });
  h.time(2000); await first.report({ activity: 'quiet' });
  await first.terminal.close();
  await expect.poll(() => h.card()?.kind).toBe('disconnected');
  const retained = h.timeline();
  expect.soft(retained).toHaveLength(2);
  h.time(6000);
  const again = await h.connect();
  await again.report({ activity: 'active' });
  expect(h.timeline()).toEqual(retained);
});
