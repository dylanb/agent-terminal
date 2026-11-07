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
  expect(exposed.get('controller')).toEqual({
    subscribeTerminals: expect.any(Function), activateTerminal: expect.any(Function), dismissTerminal: expect.any(Function),
    clearHistory: expect.any(Function),
    dismissLoopMessage: expect.any(Function),
    getTheme: expect.any(Function), setTheme: expect.any(Function),
    getAlwaysOnTop: expect.any(Function), setAlwaysOnTop: expect.any(Function), onAlwaysOnTopChanged: expect.any(Function),
  });
});

it('preserves the terminal window APIs without the controller role', async () => {
  process.argv = argv.filter(value => value !== '--agent-terminal-controller-window');
  await import('../../src/preload/index');
  expect([...exposed.keys()].sort()).toEqual(['cli', 'examples', 'flow', 'monitor', 'setup', 'term', 'viewer']);
});


it('sends an occurrence-targeted dismissal through the controller bridge', async () => {
  process.argv = [...argv, '--agent-terminal-controller-window'];
  await import('../../src/preload/index');
  const { ipcRenderer } = await import('electron');
  const { SESSION_ID } = await import('../../src/shared/ipc');
  vi.mocked(ipcRenderer.invoke).mockClear();
  const api = exposed.get('controller') as { dismissTerminal?: (id: string) => Promise<void> };
  await api.dismissTerminal?.('retained-occurrence');
  expect(ipcRenderer.invoke).toHaveBeenCalledWith('controller:dismiss', { sessionId: SESSION_ID, id: 'retained-occurrence' });
});

it('sends a loop message dismissal naming its terminal and message through the controller bridge', async () => {
  process.argv = [...argv, '--agent-terminal-controller-window'];
  await import('../../src/preload/index');
  const { ipcRenderer } = await import('electron');
  const { SESSION_ID } = await import('../../src/shared/ipc');
  vi.mocked(ipcRenderer.invoke).mockClear();
  const api = exposed.get('controller') as { dismissLoopMessage?: (terminalId: string, messageId: string) => Promise<void> };
  await api.dismissLoopMessage?.('terminal-a', 'message-a');
  expect(ipcRenderer.invoke).toHaveBeenCalledWith('controller:dismissLoopMessage', { sessionId: SESSION_ID, terminalId: 'terminal-a', messageId: 'message-a' });
});

it('reads and saves the controller theme through the controller bridge, with the session id', async () => {
  process.argv = [...argv, '--agent-terminal-controller-window'];
  await import('../../src/preload/index');
  const { ipcRenderer } = await import('electron');
  const { CONTROLLER_CH, SESSION_ID } = await import('../../src/shared/ipc');
  vi.mocked(ipcRenderer.invoke).mockClear().mockResolvedValue('dark');
  const api = exposed.get('controller') as { getTheme(): Promise<string>; setTheme(theme: string): Promise<void> };
  const read = await api.getTheme();
  await api.setTheme('dark');
  expect({ read, calls: vi.mocked(ipcRenderer.invoke).mock.calls }).toEqual({
    read: 'dark',
    calls: [[CONTROLLER_CH.getTheme, { sessionId: SESSION_ID }], [CONTROLLER_CH.setTheme, { sessionId: SESSION_ID, theme: 'dark' }]],
  });
});

it('reads and sets always-on-top through the controller bridge, with the session id, and answers main\'s replies', async () => {
  process.argv = [...argv, '--agent-terminal-controller-window'];
  await import('../../src/preload/index');
  const { ipcRenderer } = await import('electron');
  const { CONTROLLER_CH, SESSION_ID } = await import('../../src/shared/ipc');
  vi.mocked(ipcRenderer.invoke).mockClear().mockResolvedValue(false);
  const api = exposed.get('controller') as { getAlwaysOnTop(): Promise<boolean>; setAlwaysOnTop(on: boolean): Promise<boolean> };
  const read = await api.getAlwaysOnTop();
  const reply = await api.setAlwaysOnTop(true);
  expect({ read, reply, calls: vi.mocked(ipcRenderer.invoke).mock.calls }).toEqual({
    read: false,
    reply: false,
    calls: [[CONTROLLER_CH.getAlwaysOnTop, { sessionId: SESSION_ID }], [CONTROLLER_CH.setAlwaysOnTop, { sessionId: SESSION_ID, alwaysOnTop: true }]],
  });
});

it('hands each always-on-top value main pushes to the listener until it unsubscribes', async () => {
  process.argv = [...argv, '--agent-terminal-controller-window'];
  await import('../../src/preload/index');
  const { ipcRenderer } = await import('electron');
  const { CONTROLLER_CH, SESSION_ID } = await import('../../src/shared/ipc');
  vi.mocked(ipcRenderer.on).mockClear();
  vi.mocked(ipcRenderer.removeListener).mockClear();
  const api = exposed.get('controller') as { onAlwaysOnTopChanged(listener: (on: boolean) => void): () => void };
  const received: boolean[] = [];
  const unsubscribe = api.onAlwaysOnTopChanged(on => { received.push(on); });
  const receive = vi.mocked(ipcRenderer.on).mock.calls.find(([channel]) => channel === CONTROLLER_CH.alwaysOnTop)?.[1];
  receive?.({} as Electron.IpcRendererEvent, { sessionId: SESSION_ID, alwaysOnTop: false });
  receive?.({} as Electron.IpcRendererEvent, { sessionId: SESSION_ID, alwaysOnTop: true });
  unsubscribe();
  expect({
    received,
    removed: Boolean(receive) && vi.mocked(ipcRenderer.removeListener).mock.calls.some(([channel, listener]) => channel === CONTROLLER_CH.alwaysOnTop && listener === receive),
  }).toEqual({ received: [false, true], removed: true });
});
