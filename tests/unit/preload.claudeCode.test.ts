import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { on: vi.fn(), removeListener: vi.fn(), send: vi.fn(), invoke: vi.fn() },
  webUtils: { getPathForFile: vi.fn() },
}));

import { ipcRenderer } from 'electron';
import { claudeCodeApi } from '../../src/preload/index';
import { CH, SESSION_ID } from '../../src/shared/ipc';

const invoke = ipcRenderer.invoke as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => invoke.mockClear());

describe('the Claude Code integration install and remove routing', () => {
  it('installs through claudeCode:install with the session id and resolves its result', async () => {
    invoke.mockResolvedValueOnce({ ok: false, error: 'no claude found' });
    const result = await claudeCodeApi.install();
    expect({ calls: invoke.mock.calls, result }).toEqual({ calls: [[CH.claudeCodeInstall, { sessionId: SESSION_ID }]], result: { ok: false, error: 'no claude found' } });
  });

  it('removes through claudeCode:remove with the session id and resolves its result', async () => {
    invoke.mockResolvedValueOnce({ ok: true });
    const result = await claudeCodeApi.remove();
    expect({ calls: invoke.mock.calls, result }).toEqual({ calls: [[CH.claudeCodeRemove, { sessionId: SESSION_ID }]], result: { ok: true } });
  });
});
