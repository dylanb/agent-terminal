import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { on: vi.fn(), removeListener: vi.fn(), send: vi.fn(), invoke: vi.fn() },
}));

import { ipcRenderer } from 'electron';
import { viewerApi } from '../../src/preload/index';
import { CH } from '../../src/shared/ipc';

const on = ipcRenderer.on as unknown as ReturnType<typeof vi.fn>;
const removeListener = ipcRenderer.removeListener as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  on.mockClear();
  removeListener.mockClear();
});

describe('viewerApi.onChanged subscription contract (§20.1)', () => {
  it('subscribes the caller to viewer:onChanged and fires cb on a broadcast', () => {
    const cb = vi.fn();
    viewerApi.onChanged(cb);
    const call = on.mock.calls.find((c) => c[0] === CH.viewerOnChanged);
    expect(call).toBeTruthy();
    // The registered handler invokes the caller's cb (payload-free, like flow:onStateChanged).
    call![1]();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('returns a disposer that removes the same handler from the same channel', () => {
    const cb = vi.fn();
    const off = viewerApi.onChanged(cb);
    expect(typeof off).toBe('function');
    const handler = on.mock.calls.find((c) => c[0] === CH.viewerOnChanged)![1];
    off();
    expect(removeListener).toHaveBeenCalledWith(CH.viewerOnChanged, handler);
  });
});
