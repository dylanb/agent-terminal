import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const exposed = vi.hoisted(() => new Map<string, unknown>());
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (name: string, api: unknown) => exposed.set(name, api) },
  ipcRenderer: { on: vi.fn(), removeListener: vi.fn(), send: vi.fn(), invoke: vi.fn() },
  webUtils: { getPathForFile: vi.fn() },
}));

let argv: string[];
beforeEach(() => { argv = process.argv; exposed.clear(); vi.resetModules(); });
afterEach(() => { process.argv = argv; });

it('exposes only the narrow controller API to the controller window', async () => {
  process.argv = [...argv, '--agent-terminal-controller-window'];
  await import('../../src/preload/index');
  expect([...exposed.keys()]).toEqual(['controller']);
  expect(exposed.get('controller')).toEqual({ subscribeTerminals: expect.any(Function), activateTerminal: expect.any(Function) });
});

it('preserves the terminal window APIs without the controller role', async () => {
  process.argv = argv.filter(value => value !== '--agent-terminal-controller-window');
  await import('../../src/preload/index');
  expect([...exposed.keys()].sort()).toEqual(['cli', 'examples', 'flow', 'monitor', 'term', 'viewer']);
});
