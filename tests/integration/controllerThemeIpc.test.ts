import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createControllerSettingsStore } from '../../src/main/controllerSettings';
import { installControllerIpc } from '../../src/main/controllerIpc';
import { CONTROLLER_CH, SESSION_ID } from '../../src/shared/ipc';

const boundary = vi.hoisted(() => ({
  handlers: new Map<string, (event: { sender: unknown }, payload: unknown) => unknown>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    on() {}, removeListener() {},
    handle(channel: string, handler: (event: { sender: unknown }, payload: unknown) => unknown) { boundary.handlers.set(channel, handler); },
    removeHandler(channel: string) { boundary.handlers.delete(channel); },
  },
}));

const contents = { isDestroyed: () => false, send() {} };
const registry = { terminals: () => [], subscribeTerminals: () => () => {}, activate: async () => 'unavailable' as const, dismiss() {} };
let userData: string;
let dispose: (() => void) | undefined;

beforeEach(() => { userData = mkdtempSync(join(tmpdir(), 'controller-theme-ipc-')); });
afterEach(() => {
  dispose?.();
  dispose = undefined;
  rmSync(userData, { recursive: true, force: true });
});

const install = () => { dispose = installControllerIpc(contents, registry, createControllerSettingsStore(userData), { current: () => true, set() {}, subscribe: () => () => {} }); };
const invoke = async (channel: string, sender: unknown, payload: unknown) => boundary.handlers.get(channel)?.({ sender }, payload);
const savedAfterRestart = () => createControllerSettingsStore(userData).theme();

it('answers the saved theme to its own window, and light to any request its guard rejects', async () => {
  createControllerSettingsStore(userData).saveTheme('dark');
  install();
  expect({
    own: await invoke(CONTROLLER_CH.getTheme, contents, { sessionId: SESSION_ID }),
    foreignSender: await invoke(CONTROLLER_CH.getTheme, {}, { sessionId: SESSION_ID }),
    incorrectSession: await invoke(CONTROLLER_CH.getTheme, contents, { sessionId: 'wrong' }),
    nullPayload: await invoke(CONTROLLER_CH.getTheme, contents, null),
  }).toEqual({ own: 'dark', foreignSender: 'light', incorrectSession: 'light', nullPayload: 'light' });
});

it('saves a theme its own window sets, read back at once and after a restart', async () => {
  install();
  await invoke(CONTROLLER_CH.setTheme, contents, { sessionId: SESSION_ID, theme: 'dark' });
  expect({
    now: await invoke(CONTROLLER_CH.getTheme, contents, { sessionId: SESSION_ID }),
    restarted: savedAfterRestart(),
  }).toEqual({ now: 'dark', restarted: 'dark' });
});

it.each([
  ['a foreign sender', {}, { sessionId: SESSION_ID, theme: 'light' }],
  ['an incorrect session', contents, { sessionId: 'wrong', theme: 'light' }],
  ['an unrecognised theme', contents, { sessionId: SESSION_ID, theme: 'sepia' }],
  ['a null payload', contents, null],
] as const)('saves nothing for %s', async (_case, sender, payload) => {
  install();
  await invoke(CONTROLLER_CH.setTheme, contents, { sessionId: SESSION_ID, theme: 'dark' });
  await invoke(CONTROLLER_CH.setTheme, sender, payload);
  expect(savedAfterRestart()).toBe('dark');
});
