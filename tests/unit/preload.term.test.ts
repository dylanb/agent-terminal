import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { on: vi.fn(), removeListener: vi.fn(), send: vi.fn(), invoke: vi.fn() },
}));

import { ipcRenderer } from 'electron';
import { termApi } from '../../src/preload/index';
import { CH } from '../../src/shared/ipc';

const on = ipcRenderer.on as unknown as ReturnType<typeof vi.fn>;
const removeListener = ipcRenderer.removeListener as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  on.mockClear();
  removeListener.mockClear();
});

describe('termApi unsubscribe contract (§6)', () => {
  it('onData returns a disposer that removes the same handler from the same channel', () => {
    const cb = vi.fn();
    const off = termApi.onData(cb);
    expect(typeof off).toBe('function');

    const call = on.mock.calls.find((c) => c[0] === CH.ptyData);
    expect(call).toBeTruthy();
    const handler = call![1];

    off();
    expect(removeListener).toHaveBeenCalledWith(CH.ptyData, handler);
  });

  it('onExit returns a disposer that removes the same handler from the same channel', () => {
    const cb = vi.fn();
    const off = termApi.onExit(cb);
    expect(typeof off).toBe('function');

    const call = on.mock.calls.find((c) => c[0] === CH.ptyExit);
    expect(call).toBeTruthy();
    const handler = call![1];

    off();
    expect(removeListener).toHaveBeenCalledWith(CH.ptyExit, handler);
  });
});
