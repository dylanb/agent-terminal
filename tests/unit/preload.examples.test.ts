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
    const preview = {
      ok: true,
      confirmationId: 'confirmation',
      destinations: [
        { destination: 'flow', conflict: true, files: ['flow.yaml'] },
      ],
    };
    invoke.mockResolvedValueOnce(preview);
    const res = await examplesApi.preview();
    expect(invoke).toHaveBeenCalledWith(CH.installExamplesPreview, { sessionId: SESSION_ID });
    expect(res).toEqual(preview);
  });

  it('apply forwards the per-destination replace list intact', async () => {
    invoke.mockResolvedValueOnce({ ok: true, created: [], overwritten: [], skipped: [] });
    await examplesApi.apply('confirmation', ['skills', 'commands']);
    expect(invoke).toHaveBeenCalledWith(CH.installExamplesApply, {
      sessionId: SESSION_ID,
      confirmationId: 'confirmation',
      replace: ['skills', 'commands'],
    });
  });

  it('apply forwards an empty replace list as an empty list, never as a missing field', async () => {
    invoke.mockResolvedValueOnce({ ok: true, created: [], overwritten: [], skipped: [] });
    await examplesApi.apply('confirmation', []);
    expect(invoke).toHaveBeenCalledWith(CH.installExamplesApply, {
      sessionId: SESSION_ID,
      confirmationId: 'confirmation',
      replace: [],
    });
  });

  it('apply resolves the destination-grouped result', async () => {
    const result = {
      ok: true,
      created: [{ destination: 'commands', files: ['groom-ticket.md'] }],
      overwritten: [],
      skipped: [{ destination: 'flow', files: ['flow.yaml'] }],
    };
    invoke.mockResolvedValueOnce(result);
    expect(await examplesApi.apply('confirmation', ['commands'])).toEqual(
      result,
    );
  });
});
