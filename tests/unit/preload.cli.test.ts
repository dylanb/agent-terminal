import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { on: vi.fn(), removeListener: vi.fn(), send: vi.fn(), invoke: vi.fn() },
  webUtils: { getPathForFile: vi.fn() },
}));

import { ipcRenderer } from 'electron';
import { cliApi } from '../../src/preload/index';
import { CH, SESSION_ID } from '../../src/shared/ipc';

const invoke = ipcRenderer.invoke as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => invoke.mockClear());

describe('cliApi.install routing (§6 / §23.4)', () => {
  it('invokes cli:install with the session id and resolves the install result', async () => {
    invoke.mockResolvedValueOnce({ ok: true, path: '/p/agent-terminal' });
    const res = await cliApi.install();
    expect(invoke).toHaveBeenCalledWith(CH.cliInstall, { sessionId: SESSION_ID });
    expect(res).toEqual({ ok: true, path: '/p/agent-terminal' });
  });
});
