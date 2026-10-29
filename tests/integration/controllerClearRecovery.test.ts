import { expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startControllerTransport } from '../../src/main/controllerTransport';
import { registerControllerTerminal } from '../../src/main/controllerClient';
import { createLoopNotifier } from '../../src/main/loopNotifier';
import type { FlowStateView } from '../../src/shared/ipc';
import { workStatus } from '../helpers/controllerStatusFixture';

it('real source/client recovery keeps a continuing cleared per-step stop empty and permits a new identically worded stop', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'at-clear-recovery-')));
  const registry = await startControllerTransport(home);
  const source = createLoopNotifier();
  const view = (humanNeeded: boolean, status = 'complete'): FlowStateView => ({
    stepName: 'green', runStarted: 'started', steps: ['green'], position: 1, total: 1, status: 'in_progress',
    loop: { status, iteration: 1, humanNeeded, pr: null, branch: null, ready: false,
      autoGate: { deciding: !humanNeeded, hung: false, haltReasons: humanNeeded ? [{ reason: 'stop-for-a-human' }] : [] } },
  });
  let publish!: (work: ReturnType<typeof workStatus>) => void;
  let stop = () => {};
  let sequence = 0;
  const flush = async () => {
    const reason = `Live barrier ${++sequence}`;
    publish(workStatus({ error: { reason }, attention: { status: 'complete', reasons: ['Current gate'] } }));
    await expect.poll(() => registry.terminals()[0]?.work?.error?.reason).toBe(reason);
  };
  const connect = async () => {
    stop = registerControllerTerminal(home, { launchDirectory: '/work', repositoryRoot: '/work' }, () => 'activated', () => {}, listener => {
      publish = listener; listener(workStatus()); return () => {};
    }, () => {}, source);
    await expect.poll(() => registry.terminals()[0]?.status === 'disconnected' ? undefined : registry.terminals()[0]?.work).toEqual(workStatus());
    await flush();
  };
  const disconnect = async () => {
    stop(); await expect.poll(() => registry.terminals()[0]?.status).toBe('disconnected');
  };
  try {
    source.observe('/work', view(true)); await connect();
    expect(registry.terminals()[0].notifications).toMatchObject([{ message: 'complete · iter 1', count: 1 }]);
    expect(registry.clearHistory(registry.terminals()[0].clearHistoryTarget!)).toBe('cleared');
    source.observe('/work', view(true, 'error')); await flush();
    expect.soft(registry.terminals()[0].notifications).toEqual([]);
    await disconnect(); await connect();
    expect.soft(registry.terminals()[0].notifications).toEqual([]);
    expect.soft(registry.terminals()[0].work?.attention?.reasons).toEqual(['Current gate']);
    expect(registry.clearHistory(registry.terminals()[0].clearHistoryTarget!)).toBe('cleared');
    source.observe('/work', view(false)); source.observe('/work', view(true)); await flush();
    expect.soft(registry.terminals()[0].notifications).toMatchObject([{ message: 'complete · iter 1', count: 1 }]);
    expect(registry.clearHistory(registry.terminals()[0].clearHistoryTarget!)).toBe('cleared');
    await disconnect(); source.observe('/work', view(false)); await connect();
    expect.soft(registry.terminals()[0].notifications).toEqual([]);
  } finally { stop(); await registry.dispose(); rmSync(home, { recursive: true, force: true }); }
});

it('a disposed source cannot refill its cleared directory after a fresh terminal session replaces it', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'at-clear-session-')));
  const registry = await startControllerTransport(home);
  const oldSource = createLoopNotifier(); const replacement = createLoopNotifier();
  const view = (iteration: number): FlowStateView => ({
    stepName: 'green', runStarted: 'started', steps: ['green'], position: 1, total: 1, status: 'in_progress',
    loop: { status: 'complete', iteration, humanNeeded: true, pr: null, branch: null, ready: false },
  });
  const identity = { launchDirectory: '/work', repositoryRoot: '/work' };
  oldSource.observe('/work', view(1));
  const stopOld = registerControllerTerminal(home, identity, () => 'activated', () => {}, undefined, () => {}, oldSource);
  let stopNew = () => {};
  let publish!: (work: ReturnType<typeof workStatus>) => void;
  try {
    await expect.poll(() => registry.terminals()[0]?.notifications?.length).toBe(1);
    expect(registry.clearHistory(registry.terminals()[0].clearHistoryTarget!)).toBe('cleared');
    stopOld(); await expect.poll(() => registry.terminals()[0]?.status).toBe('disconnected');
    stopNew = registerControllerTerminal(home, identity, () => 'activated', () => {}, listener => {
      publish = listener; listener(workStatus()); return () => {};
    }, () => {}, replacement);
    await expect.poll(() => registry.terminals()[0]?.work).toEqual(workStatus());
    oldSource.observe('/work', view(2));
    replacement.observe('/work', view(3));
    publish(workStatus({ error: { reason: 'after both source publications' } }));
    await expect.poll(() => registry.terminals()[0]?.work?.error?.reason).toBe('after both source publications');
    expect.soft(registry.terminals()[0].notifications).toMatchObject([{ message: 'complete · iter 3', count: 1 }]);
    expect.soft(registry.terminals()[0].notifications).toHaveLength(1);
  } finally { stopOld(); stopNew(); await registry.dispose(); rmSync(home, { recursive: true, force: true }); }
});
