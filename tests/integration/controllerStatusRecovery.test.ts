import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerControllerTerminal } from '../../src/main/controllerClient';
import { startControllerTransport, type ControllerRegistry } from '../../src/main/controllerTransport';
import { createControllerStatus } from '../../src/main/controllerStatus';
import type { ControllerWorkStatus } from '../../src/shared/ipc';
import { workStatus } from '../helpers/controllerStatusFixture';

const home = realpathSync(mkdtempSync(join(tmpdir(), 'at-status-recovery-')));
let registry: ControllerRegistry | undefined;
const stops: Array<() => void> = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  await registry?.dispose();
  registry = undefined;
  rmSync(home, { recursive: true, force: true });
});

it('repeated real-socket recovery publishes current peer state and rejects callbacks from ended connections', async () => {
  registry = await startControllerTransport(home);
  const current = [workStatus({ attention: { status: 'complete', reasons: ['old halt'] } }), workStatus({ ticket: { availability: 'none' } })];
  const callbacks: Array<Array<(work: ControllerWorkStatus) => void>> = [[], []];
  const starts = [0, 0];
  const activations = [0, 0];
  for (const peer of [0, 1]) stops.push(registerControllerTerminal(home,
    { launchDirectory: '/same/fixed', repositoryRoot: '/same' },
    () => { activations[peer]++; return 'activated'; }, () => { starts[peer]++; },
    listener => { callbacks[peer].push(listener); listener(current[peer]); return () => {}; }));
  await expect.poll(() => registry!.terminals().map(t => t.work)).toEqual(expect.arrayContaining(current));
  for (let round = 0; round < 2; round++) {
    const stale = callbacks.map(items => items.at(-1)!);
    await registry.dispose();
    registry = undefined;
    current[0] = workStatus({ flow: { availability: 'known', name: 'new-context', step: `step-${round}`, assignment: 'assigned' }, ticket: { availability: 'none' }, activity: 'quiet' });
    registry = await startControllerTransport(home);
    await expect.poll(() => registry!.terminals().map(t => t.work), { timeout: 8_000 }).toEqual(expect.arrayContaining(current));
    stale.forEach(listener => listener(workStatus({ attention: { status: 'error', reasons: ['obsolete delayed result'] } })));
    for (const terminal of registry.terminals()) expect(await registry.activate(terminal.id)).toBe('activated');
    expect(registry.terminals()).toHaveLength(2);
    expect(registry.terminals().map(t => t.work)).toEqual(expect.arrayContaining(current));
    expect(registry.terminals().map(t => t.launchDirectory)).toEqual(['/same/fixed', '/same/fixed']);
    expect(starts).toEqual([1, 1]);
    expect(activations).toEqual([round + 1, round + 1]);
  }
}, 25_000);

it('late pre-outage title cannot overwrite current work after real-socket recovery', async () => {
  registry = await startControllerTransport(home);
  let repo = '/old';
  let release!: (value: string | null) => void;
  const pending = new Promise<string | null>(resolve => { release = resolve; });
  const source = createControllerStatus({
    current: () => ({ repoKey: repo, flowName: repo, activity: 'quiet', view: {
      stepName: 'work', status: 'in_progress', runStarted: 'started', refs: { ticket: repo === '/old' ? 219 : 220 },
    } }),
    issueTitle: async directory => directory === '/old' ? pending : 'CURRENT_TITLE',
  });
  stops.push(() => source.dispose());
  source.refresh();
  stops.push(registerControllerTerminal(home, { launchDirectory: '/fixed', repositoryRoot: '/fixed' }, () => 'activated', () => {}, source.subscribe));
  await expect.poll(() => registry!.terminals()[0]?.work?.ticket).toMatchObject({ number: 219, title: { availability: 'loading' } });
  await registry.dispose();
  registry = undefined;
  repo = '/new';
  source.refresh();
  registry = await startControllerTransport(home);
  await expect.poll(() => registry!.terminals()[0]?.work?.ticket, { timeout: 8_000 }).toMatchObject({ number: 220, title: { text: 'CURRENT_TITLE' } });
  const seen: ControllerWorkStatus[] = [];
  const unsubscribe = registry.subscribeTerminals(terminals => { for (const terminal of terminals) if (terminal.work) seen.push(terminal.work); });
  release('OBSOLETE_TITLE');
  await pending;
  await new Promise(resolve => setTimeout(resolve, 100));
  unsubscribe();
  expect(seen.every(work => work.ticket.availability === 'known' && work.ticket.number === 220 && work.ticket.title.availability === 'known' && work.ticket.title.text === 'CURRENT_TITLE')).toBe(true);
  expect(await registry.activate(registry.terminals()[0].id)).toBe('activated');
  stops.splice(0).forEach(stop => stop());
  await expect.poll(() => registry!.terminals()[0]?.status).toBe('disconnected');
  expect(await registry.activate(registry.terminals()[0].id)).toBe('unavailable');
  registry.dismiss(registry.terminals()[0].id);
  expect(registry.terminals()).toEqual([]);
}, 15_000);
