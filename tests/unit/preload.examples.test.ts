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
    invoke.mockResolvedValueOnce({ destinations: [{ destination: 'flow', conflict: true, files: ['flow.yaml'] }] });
    const res = await examplesApi.preview();
    expect(invoke).toHaveBeenCalledWith(CH.installExamplesPreview, { sessionId: SESSION_ID });
    expect(res).toEqual({ destinations: [{ destination: 'flow', conflict: true, files: ['flow.yaml'] }] });
  });

  it('apply forwards the per-destination replace list intact', async () => {
    invoke.mockResolvedValueOnce({ ok: true, created: [], overwritten: [], skipped: [] });
    await examplesApi.apply(['skills', 'commands']);
    expect(invoke).toHaveBeenCalledWith(CH.installExamplesApply, {
      sessionId: SESSION_ID,
      replace: ['skills', 'commands'],
    });
  });

  it('apply forwards an empty replace list as an empty list, never as a missing field', async () => {
    invoke.mockResolvedValueOnce({ ok: true, created: [], overwritten: [], skipped: [] });
    await examplesApi.apply([]);
    expect(invoke).toHaveBeenCalledWith(CH.installExamplesApply, { sessionId: SESSION_ID, replace: [] });
  });

  it('apply resolves the destination-grouped result', async () => {
    const result = {
      ok: true,
      created: [{ destination: 'commands', files: ['groom-ticket.md'] }],
      overwritten: [],
      skipped: [{ destination: 'flow', files: ['flow.yaml'] }],
    };
    invoke.mockResolvedValueOnce(result);
    expect(await examplesApi.apply(['commands'])).toEqual(result);
  });
});
