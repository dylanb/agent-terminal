import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { on: vi.fn(), removeListener: vi.fn(), send: vi.fn(), invoke: vi.fn() },
  webUtils: { getPathForFile: vi.fn() },
}));

import { ipcRenderer } from 'electron';
import { examplesApi } from '../../src/preload/index';
import { CH, SESSION_ID } from '../../src/shared/ipc';

const invoke = ipcRenderer.invoke as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => invoke.mockClear());

describe('examplesApi routing (§6 / §18.1)', () => {
  it('preview invokes examples:preview with the session id and resolves the preview', async () => {
    invoke.mockResolvedValueOnce({ conflicts: ['flow.yaml'] });
    const res = await examplesApi.preview();
    expect(invoke).toHaveBeenCalledWith(CH.installExamplesPreview, { sessionId: SESSION_ID });
    expect(res).toEqual({ conflicts: ['flow.yaml'] });
  });

  it('apply invokes examples:apply with the session id and the overwrite decision', async () => {
    invoke.mockResolvedValueOnce({ ok: true, created: ['flow.yaml'], overwritten: [], skipped: [] });
    const res = await examplesApi.apply(true);
    expect(invoke).toHaveBeenCalledWith(CH.installExamplesApply, { sessionId: SESSION_ID, overwrite: true });
    expect(res).toEqual({ ok: true, created: ['flow.yaml'], overwritten: [], skipped: [] });
  });
});
