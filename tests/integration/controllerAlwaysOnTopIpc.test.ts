import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createControllerAlwaysOnTop } from '../../src/main/controllerAlwaysOnTop';
import { createControllerSettingsStore } from '../../src/main/controllerSettings';
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

const contents = { isDestroyed: () => false, send() {} };
const registry = { terminals: () => [], subscribeTerminals: () => () => {}, activate: async () => 'unavailable' as const, dismiss() {} };
let userData: string;
let dispose: (() => void) | undefined;

beforeEach(() => { userData = mkdtempSync(join(tmpdir(), 'controller-always-on-top-ipc-')); });
afterEach(() => {
  dispose?.();
  dispose = undefined;
  rmSync(userData, { recursive: true, force: true });
});

/** Installs the controller IPC over a real always-on-top owner; `applied` is each value the window was told to take. */
function install(initial: boolean) {
  const applied: boolean[] = [];
  const owner = createControllerAlwaysOnTop({ window: { setAlwaysOnTop(on) { applied.push(on); } }, initial });
  dispose = installControllerIpc(contents, registry, createControllerSettingsStore(userData), owner);
  return { applied };
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
