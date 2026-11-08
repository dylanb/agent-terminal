import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerControllerTerminal } from '../../src/main/controllerClient';
import type { ControllerIdentity } from '../../src/main/controllerIdentity';
import { startControllerTransport } from '../../src/main/controllerTransport';
import { CONTROLLER_CH, SESSION_ID, type ControllerSnapshot } from '../../src/shared/ipc';
import { installControllerIpc } from '../../src/main/controllerIpc';
import { createControllerSettingsStore } from '../../src/main/controllerSettings';
import { withActivity, workStatus, type WorkStatus } from '../helpers/controllerStatusFixture';
import { connectScriptedTerminal, type ScriptedControllerTerminal } from '../helpers/scriptedControllerTerminal';

vi.mock('electron', () => ({ ipcMain: {
  on() {}, removeListener() {}, handle() {}, removeHandler() {},
} }));

let disposeIpc: (() => void) | undefined;
let stopClient: (() => void) | undefined;
let snapshot: ControllerSnapshot;
let root: string;
let server: Awaited<ReturnType<typeof startControllerTransport>>;
const terminals: ScriptedControllerTerminal[] = [];

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'at-status-')));
  server = await startControllerTransport(root);
});
afterEach(async () => {
  await Promise.all(terminals.splice(0).map(terminal => terminal.close()));
  stopClient?.();
  stopClient = undefined;
  disposeIpc?.();
  disposeIpc = undefined;
  await server?.dispose();
  rmSync(root, { recursive: true, force: true });
});

async function register(directory: string): Promise<ScriptedControllerTerminal> {
  const terminal = await connectScriptedTerminal(root, { launchDirectory: directory, repositoryRoot: '/repo' });
  terminals.push(terminal);
  return terminal;
}

it('publishes complete current work only for the socket owning the terminal', async () => {
  const left = await register('/repo/left');
  await register('/repo/right');
  const work = workStatus({ attention: { status: 'complete', reasons: ['Review required'] }, error: { reason: 'Checks failed' } });
  await left.sendStatus(work);
  await expect.poll(() => server.terminals()).toEqual([
    { id: expect.any(String), launchDirectory: '/repo/left', repositoryRoot: '/repo', work },
    { id: expect.any(String), launchDirectory: '/repo/right', repositoryRoot: '/repo' },
  ]);
});

it('a new subscriber receives the latest complete status including cleared conditions', async () => {
  const terminal = await register('/repo/current');
  const old = workStatus({ attention: { status: 'error', reasons: ['Old halt'] }, error: { reason: 'Old failure' } });
  const current = workStatus({ flow: { availability: 'known', name: 'next', step: 'verify', assignment: 'assigned' }, ticket: { availability: 'none' }, activity: 'quiet' });
  for (const work of [old, current]) await terminal.sendStatus(work);
  let snapshot: ReturnType<typeof server.terminals> = [];
  const unsubscribe = server.subscribeTerminals(items => { snapshot = items; });
  try {
    await expect.poll(() => snapshot).toEqual([expect.objectContaining({ launchDirectory: '/repo/current', work: current })]);
  } finally { unsubscribe(); }
});

it('publishes a complete accessible reason through the real client beyond one legacy frame', async () => {
  const reason = 'The current check needs a human decision. '.repeat(1000);
  const work = workStatus({ attention: { status: 'complete', reasons: [reason] } });
  const registerWithStatus: (
    home: string, identity: ControllerIdentity, activate: () => 'activated' | 'unavailable',
    onRegistered: () => void, subscribeStatus: (listener: (work: WorkStatus) => void) => () => void,
  ) => () => void = registerControllerTerminal;
  stopClient = registerWithStatus(root, { launchDirectory: '/repo/long-reason', repositoryRoot: '/repo' }, () => 'activated', () => {}, listener => {
    listener(work);
    return () => {};
  });
  await expect.poll(() => server.terminals()).toEqual([expect.objectContaining({ work })]);
});

it('carries real-socket status through the actual controller IPC snapshot boundary', async () => {
  const terminal = await register('/repo/ipc');
  const work = workStatus({ activity: 'quiet' });
  snapshot = { sessionId: SESSION_ID, terminals: [] };
  disposeIpc = installControllerIpc({
    isDestroyed: () => false,
    send(channel: string, value: ControllerSnapshot) { if (channel === CONTROLLER_CH.terminals) snapshot = value; },
  }, server, createControllerSettingsStore(root), { current: () => true, set() {}, subscribe: () => () => {} });
  await terminal.sendStatus(work);
  await expect.poll(() => snapshot).toMatchObject({ sessionId: SESSION_ID, terminals: [expect.objectContaining({ launchDirectory: '/repo/ipc', work })] });
});

it('isolates registry snapshots and subscribers from each other through nested status values', async () => {
  const terminal = await register('/repo/owned');
  const work = workStatus({ attention: { status: 'complete', reasons: ['Original reason'] }, error: { reason: 'Original error' } });
  await terminal.sendStatus(work);
  await expect.poll(() => server.terminals()[0]?.work).toEqual(work);
  const copy = server.terminals();
  copy[0].work!.attention!.reasons.push('Caller mutation');
  copy[0].work!.error!.reason = 'Caller mutation';
  expect(server.terminals()[0].work).toEqual(work);
  const stopMutator = server.subscribeTerminals(items => { items[0].work!.attention!.reasons.push('Subscriber mutation'); });
  let received: typeof copy = [];
  const stopObserver = server.subscribeTerminals(items => { received = items; });
  try {
    expect(received[0].work).toEqual(work);
    const updated = withActivity(work, 'quiet');
    await terminal.sendStatus(updated);
    await expect.poll(() => received[0]?.work).toEqual(updated);
  } finally { stopMutator(); stopObserver(); }
});
