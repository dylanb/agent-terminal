import { expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startControllerTransport } from '../../src/main/controllerTransport';
import { registerControllerTerminal } from '../../src/main/controllerClient';
import { createLoopNotifier } from '../../src/main/loopNotifier';
import type { FlowStateView } from '../../src/shared/ipc';
import { notificationEntries } from '../helpers/controllerHistory';
import { workStatus } from '../helpers/controllerStatusFixture';

it('does not reconstruct an ended survivor request when overlap clears through the real source and client', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'at-surv-')));
  const registry = await startControllerTransport(home);
  const source = createLoopNotifier();
  const view = (humanNeeded: boolean): FlowStateView => ({
    stepName: 'green', runStarted: 'started', steps: ['green'], stepRuns: ['runs'], decisions: {}, position: 1, total: 1, status: 'in_progress',
    loop: { status: 'complete', iteration: 1, humanNeeded, pr: null, branch: null, ready: false },
  });
  const identity = { launchDirectory: '/work', repositoryRoot: '/work' };
  let publish: ((work: ReturnType<typeof workStatus>) => void) | undefined;
  source.observe('/work', view(true));
  const stop = registerControllerTerminal(home, identity, () => 'activated', () => {}, listener => {
    publish = listener; listener(workStatus()); return () => {};
  }, () => {}, source);
  let stopPeer = () => {};
  try {
    await expect.poll(() => notificationEntries(registry.terminals()[0])[0]?.message).toBe('complete · iter 1');
    const survivorId = registry.terminals()[0].id;
    stopPeer = registerControllerTerminal(home, identity, () => 'activated');
    await expect.poll(() => registry.terminals().length).toBe(2);
    source.observe('/work', view(false));
    publish!(workStatus({ error: { reason: 'barrier after ended request' } }));
    await expect.poll(() => registry.terminals().find(t => t.id === survivorId)?.work?.error?.reason).toBe('barrier after ended request');
    stopPeer();
    await expect.poll(() => registry.terminals().length).toBe(1);
    expect(notificationEntries(registry.terminals()[0])).toEqual([]);
  } finally {
    stopPeer(); stop(); await registry.dispose(); rmSync(home, { recursive: true, force: true });
  }
});

it('current-condition changes preserve legacy qualification instead of creating additional arrivals', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'at-cur-')));
  const registry = await startControllerTransport(home);
  const source = createLoopNotifier();
  const view = (humanNeeded: boolean): FlowStateView => ({
    stepName: 'green', runStarted: 'started', steps: ['green'], stepRuns: ['runs'], decisions: {}, position: 1, total: 1, status: 'in_progress',
    loop: { status: 'complete', iteration: 1, humanNeeded, pr: null, branch: null, ready: false },
  });
  let publish: ((work: ReturnType<typeof workStatus>) => void) | undefined;
  const stop = registerControllerTerminal(home, { launchDirectory: '/work', repositoryRoot: '/work' }, () => 'activated', () => {}, listener => {
    publish = listener; listener(workStatus()); return () => {};
  }, () => {}, source);
  try {
    await expect.poll(() => registry.terminals()[0]?.work).toEqual(workStatus());
    source.observe('/work', view(true));
    await expect.poll(() => notificationEntries(registry.terminals()[0])[0]?.count).toBe(1);
    const first = notificationEntries(registry.terminals()[0]);
    source.observe('/work', view(false));
    source.observe('/work', view(true));
    publish!(workStatus({ error: { reason: 'barrier after current refresh' } }));
    await expect.poll(() => registry.terminals()[0]?.work?.error?.reason).toBe('barrier after current refresh');
    expect(notificationEntries(registry.terminals()[0])).toEqual(first);
  } finally {
    stop(); await registry.dispose(); rmSync(home, { recursive: true, force: true });
  }
});
