import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createControllerSettingsStore } from '../../src/main/controllerSettings';
import { installControllerIpc } from '../../src/main/controllerIpc';
import { SESSION_ID } from '../../src/shared/ipc';

const GET_SORT_MODE = 'controller:getSortMode';
const SET_SORT_MODE = 'controller:setSortMode';
const GET_THEME = 'controller:getTheme';

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
const registry = { terminals: () => [], subscribeTerminals: () => () => {}, activate: async () => 'unavailable' as const, dismiss() {}, dismissLoopMessage() {}, clearHistory: () => 'unavailable' as const };
let userData: string;
let dispose: (() => void) | undefined;

beforeEach(() => { userData = mkdtempSync(join(tmpdir(), 'controller-sort-mode-ipc-')); });
afterEach(() => {
  dispose?.();
  dispose = undefined;
  rmSync(userData, { recursive: true, force: true });
});

const install = () => { dispose = installControllerIpc(contents, registry, createControllerSettingsStore(userData), { current: () => true, set() {}, subscribe: () => () => {} }); };
const invoke = async (channel: string, sender: unknown, payload: unknown) => boundary.handlers.get(channel)?.({ sender }, payload);
const savedAfterRestart = () => createControllerSettingsStore(userData).sortMode();
const own = { sessionId: SESSION_ID };

it('answers the saved card order to its own window, and Attention to any request its guard rejects', async () => {
  createControllerSettingsStore(userData).saveSortMode('recently-used');
  install();
  expect({
    own: await invoke(GET_SORT_MODE, contents, own),
    foreignSender: await invoke(GET_SORT_MODE, {}, own),
    incorrectSession: await invoke(GET_SORT_MODE, contents, { sessionId: 'wrong' }),
    nullPayload: await invoke(GET_SORT_MODE, contents, null),
  }).toEqual({ own: 'recently-used', foreignSender: 'attention', incorrectSession: 'attention', nullPayload: 'attention' });
});

it('saves a card order its own window sets, read back at once and after a restart', async () => {
  install();
  await invoke(SET_SORT_MODE, contents, { ...own, sortMode: 'recently-used' });
  expect({
    now: await invoke(GET_SORT_MODE, contents, own),
    restarted: savedAfterRestart(),
  }).toEqual({ now: 'recently-used', restarted: 'recently-used' });
});

it.each([
  ['a foreign sender', {}, { sessionId: SESSION_ID, sortMode: 'attention' }],
  ['an incorrect session', contents, { sessionId: 'wrong', sortMode: 'attention' }],
  ['neither of the two orders', contents, { sessionId: SESSION_ID, sortMode: 'by-name' }],
  ['a null payload', contents, null],
] as const)('saves nothing for %s', async (_case, sender, payload) => {
  install();
  await invoke(SET_SORT_MODE, contents, { ...own, sortMode: 'recently-used' });
  const files = readdirSync(userData).map(name => [name, readFileSync(join(userData, name), 'utf8')]);
  await invoke(SET_SORT_MODE, sender, payload);
  expect({ sortMode: savedAfterRestart(), files: readdirSync(userData).map(name => [name, readFileSync(join(userData, name), 'utf8')]) })
    .toEqual({ sortMode: 'recently-used', files });
});

it('answers Attention for a damaged saved card order while the theme read still answers the saved theme', async () => {
  createControllerSettingsStore(userData).saveTheme('dark');
  const themeFiles = new Set(readdirSync(userData));
  install();
  await invoke(SET_SORT_MODE, contents, { ...own, sortMode: 'recently-used' });
  const saved = await invoke(GET_SORT_MODE, contents, own);
  for (const name of readdirSync(userData).filter(name => !themeFiles.has(name))) writeFileSync(join(userData, name), 'not json {{{');
  expect({ saved, sortMode: await invoke(GET_SORT_MODE, contents, own), theme: await invoke(GET_THEME, contents, own) })
    .toEqual({ saved: 'recently-used', sortMode: 'attention', theme: 'dark' });
});
