import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createControllerAlwaysOnTop } from '../../src/main/controllerAlwaysOnTop';
import { createControllerSettingsStore } from '../../src/main/controllerSettings';
import { createControllerWindowStateStore } from '../../src/main/controllerWindowState';
import { installControllerIpc } from '../../src/main/controllerIpc';
import { CONTROLLER_CH, CONTROLLER_DEFAULT_ALWAYS_ON_TOP, SESSION_ID } from '../../src/shared/ipc';

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

/** Each always-on-top value main pushed to the window, with its payload. */
const pushed: unknown[] = [];
const contents = { isDestroyed: () => false, send(channel: string, payload: unknown) { if (channel === CONTROLLER_CH.alwaysOnTop) pushed.push(payload); } };
const registry = { terminals: () => [], subscribeTerminals: () => () => {}, activate: async () => 'unavailable' as const, dismiss() {}, clearHistory: () => 'unavailable' as const, dismissLoopMessage() {} };
let userData: string;
let dispose: (() => void) | undefined;

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'controller-always-on-top-ipc-'));
  pushed.length = 0;
});
afterEach(() => {
  dispose?.();
  dispose = undefined;
  rmSync(userData, { recursive: true, force: true });
});

/** Installs the controller IPC over a real always-on-top owner and window-state store; `applied` is each value the
 *  window was told to take. */
function install(initial: boolean) {
  const applied: boolean[] = [];
  const store = createControllerWindowStateStore(userData);
  const owner = createControllerAlwaysOnTop({ window: { setAlwaysOnTop(on) { applied.push(on); } }, store, initial });
  dispose = installControllerIpc(contents, registry, createControllerSettingsStore(userData), owner);
  return { applied, owner };
}
/** Disposes the running IPC and installs it again over the always-on-top choice a fresh store loads, as a relaunch does. */
function relaunch() {
  dispose?.();
  return install(createControllerWindowStateStore(userData).load().alwaysOnTop);
}
const invoke = async (channel: string, sender: unknown, payload: unknown) => boundary.handlers.get(channel)?.({ sender }, payload);
const readBack = () => invoke(CONTROLLER_CH.getAlwaysOnTop, contents, { sessionId: SESSION_ID });

it('answers the value main holds to its own window, and the default to any request its guard rejects', async () => {
  install(!CONTROLLER_DEFAULT_ALWAYS_ON_TOP);
  expect({
    own: await readBack(),
    foreignSender: await invoke(CONTROLLER_CH.getAlwaysOnTop, {}, { sessionId: SESSION_ID }),
    incorrectSession: await invoke(CONTROLLER_CH.getAlwaysOnTop, contents, { sessionId: 'wrong' }),
    nullPayload: await invoke(CONTROLLER_CH.getAlwaysOnTop, contents, null),
  }).toEqual({
    own: !CONTROLLER_DEFAULT_ALWAYS_ON_TOP,
    foreignSender: CONTROLLER_DEFAULT_ALWAYS_ON_TOP,
    incorrectSession: CONTROLLER_DEFAULT_ALWAYS_ON_TOP,
    nullPayload: CONTROLLER_DEFAULT_ALWAYS_ON_TOP,
  });
});

it('applies each value its own window sets to the window, and replies and reads back that value', async () => {
  const { applied } = install(true);
  const off = { reply: await invoke(CONTROLLER_CH.setAlwaysOnTop, contents, { sessionId: SESSION_ID, alwaysOnTop: false }), readBack: await readBack() };
  const on = { reply: await invoke(CONTROLLER_CH.setAlwaysOnTop, contents, { sessionId: SESSION_ID, alwaysOnTop: true }), readBack: await readBack() };
  expect({ off, on, applied }).toEqual({ off: { reply: false, readBack: false }, on: { reply: true, readBack: true }, applied: [false, true] });
});

it.each([
  ['a foreign sender', {}, { sessionId: SESSION_ID, alwaysOnTop: true }],
  ['an incorrect session', contents, { sessionId: 'wrong', alwaysOnTop: true }],
  ['a value that is not a boolean', contents, { sessionId: SESSION_ID, alwaysOnTop: 'true' }],
  ['a null payload', contents, null],
] as const)('leaves the window and the value unchanged for %s, and replies the unchanged value', async (_case, sender, payload) => {
  const { applied } = install(false);
  const reply = await invoke(CONTROLLER_CH.setAlwaysOnTop, sender, payload);
  expect({ reply, readBack: await readBack(), applied }).toEqual({ reply: false, readBack: false, applied: [] });
});

it('keeps each value its own window sets across a relaunch over the same userData', async () => {
  install(CONTROLLER_DEFAULT_ALWAYS_ON_TOP);
  await invoke(CONTROLLER_CH.setAlwaysOnTop, contents, { sessionId: SESSION_ID, alwaysOnTop: false });
  relaunch();
  const off = await readBack();
  await invoke(CONTROLLER_CH.setAlwaysOnTop, contents, { sessionId: SESSION_ID, alwaysOnTop: true });
  relaunch();
  expect({ off, on: await readBack() }).toEqual({ off: false, on: true });
});

it('keeps the accepted value across a relaunch when its guard rejects later sets of the other value', async () => {
  install(true);
  await invoke(CONTROLLER_CH.setAlwaysOnTop, contents, { sessionId: SESSION_ID, alwaysOnTop: false });
  await invoke(CONTROLLER_CH.setAlwaysOnTop, {}, { sessionId: SESSION_ID, alwaysOnTop: true });
  await invoke(CONTROLLER_CH.setAlwaysOnTop, contents, { sessionId: 'wrong', alwaysOnTop: true });
  await invoke(CONTROLLER_CH.setAlwaysOnTop, contents, { sessionId: SESSION_ID, alwaysOnTop: 1 });
  relaunch();
  const keptOff = await readBack();
  await invoke(CONTROLLER_CH.setAlwaysOnTop, contents, { sessionId: SESSION_ID, alwaysOnTop: true });
  await invoke(CONTROLLER_CH.setAlwaysOnTop, {}, { sessionId: SESSION_ID, alwaysOnTop: false });
  await invoke(CONTROLLER_CH.setAlwaysOnTop, contents, { sessionId: 'wrong', alwaysOnTop: false });
  await invoke(CONTROLLER_CH.setAlwaysOnTop, contents, { sessionId: SESSION_ID, alwaysOnTop: 0 });
  relaunch();
  expect({ keptOff, keptOn: await readBack() }).toEqual({ keptOff: false, keptOn: true });
});

it('tells every subscriber each value it takes from its own window or the tray, and nothing a guard refused', async () => {
  const { owner } = install(true);
  const first: boolean[] = [];
  const second: boolean[] = [];
  const leaving: boolean[] = [];
  owner.subscribe(on => { first.push(on); });
  owner.subscribe(on => { second.push(on); });
  const leave = owner.subscribe(on => { leaving.push(on); });
  [first, second, leaving].forEach(values => { values.length = 0; });
  await invoke(CONTROLLER_CH.setAlwaysOnTop, contents, { sessionId: SESSION_ID, alwaysOnTop: false });
  leave();
  await invoke(CONTROLLER_CH.setAlwaysOnTop, {}, { sessionId: SESSION_ID, alwaysOnTop: true });
  owner.set(true);
  expect({ first, second, leaving }).toEqual({ first: [false, true], second: [false, true], leaving: [false] });
});

it('pushes each value it takes, from its own window or the tray, to the window with the session id until disposed', async () => {
  const { owner } = install(true);
  const before = pushed.length;
  await invoke(CONTROLLER_CH.setAlwaysOnTop, contents, { sessionId: SESSION_ID, alwaysOnTop: false });
  owner.set(true);
  dispose?.();
  dispose = undefined;
  owner.set(false);
  expect(pushed.slice(before)).toEqual([{ sessionId: SESSION_ID, alwaysOnTop: false }, { sessionId: SESSION_ID, alwaysOnTop: true }]);
});
