import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { on: vi.fn(), removeListener: vi.fn(), send: vi.fn(), invoke: vi.fn() },
  webUtils: { getPathForFile: vi.fn() },
}));

import { contextBridge, ipcRenderer } from 'electron';
import '../../src/preload/index';
import { isValidFlowListCatalog as isValid } from '../../src/main/ipcValidation';
import { SESSION_ID, type FlowApi } from '../../src/shared/ipc';

// A3 (#134) §6 — `flow:listCatalog` carries `sessionId` + the `repoKey` of the worktree it lists (§18.7.6), and
// main rejects any other shape before it touches a worktree.

const invoke = ipcRenderer.invoke as unknown as ReturnType<typeof vi.fn>;
const expose = contextBridge.exposeInMainWorld as unknown as ReturnType<typeof vi.fn>;

function exposedFlow(): FlowApi {
  const call = expose.mock.calls.find(([name]) => name === 'flow');
  if (!call) throw new Error('the preload never exposed the flow namespace');
  return call[1] as FlowApi;
}

beforeEach(() => invoke.mockClear());

describe('window.flow.listCatalog (§6 / §18.7.6)', () => {
  it('invokes flow:listCatalog with the session id and the named worktree, and resolves the listing result', async () => {
    const flow = exposedFlow();
    const listing = { ok: true, listing: { entries: [], tierNotices: [], recoveryOutcomes: [] } };
    invoke.mockResolvedValueOnce(listing);

    const res = await flow.listCatalog('/repo-a');

    expect(invoke).toHaveBeenCalledWith('flow:listCatalog', { sessionId: SESSION_ID, repoKey: '/repo-a' });
    expect(res).toEqual(listing);
  });
});

describe('flow:listCatalog payload validation (§6 — renderer-supplied input is untrusted)', () => {
  it('accepts { sessionId, repoKey } for a safe repoKey on the live session and rejects every other shape', () => {
    expect(isValid({ sessionId: SESSION_ID, repoKey: '/repo' })).toBe(true);
    expect(isValid({ sessionId: SESSION_ID, repoKey: 'relative' })).toBe(false);
    expect(isValid({ sessionId: SESSION_ID, repoKey: '/repo/../etc' })).toBe(false);
    expect(isValid({ sessionId: SESSION_ID, repoKey: '' })).toBe(false);
    expect(isValid({ sessionId: SESSION_ID, repoKey: 42 })).toBe(false);
    expect(isValid({ sessionId: SESSION_ID, repoKey: undefined })).toBe(false);
    expect(isValid({ sessionId: SESSION_ID })).toBe(false);
    expect(isValid({ sessionId: 'other', repoKey: '/repo' })).toBe(false);
    expect(isValid(null)).toBe(false);
    const arr = Object.assign([], { sessionId: SESSION_ID, repoKey: '/repo' });
    expect(isValid(arr)).toBe(false);
  });
});
