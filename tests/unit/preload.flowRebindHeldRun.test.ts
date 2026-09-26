import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { on: vi.fn(), removeListener: vi.fn(), send: vi.fn(), invoke: vi.fn() },
  webUtils: { getPathForFile: vi.fn() },
}));

import { contextBridge, ipcRenderer } from 'electron';
import '../../src/preload/index';
import { isValidFlowRebindHeldRun as isValid } from '../../src/main/ipcValidation';
import { SESSION_ID, type FlowApi } from '../../src/shared/ipc';
import { MAX_CATALOG_ID_LENGTH } from '../../src/shared/pathSegment';

// A3 (#134) §6 — `flow:rebindHeldRun` carries `sessionId`, the `repoKey` of the held worktree, and the operator's
// choice; main rejects any other shape before it touches a worktree.

const invoke = ipcRenderer.invoke as unknown as ReturnType<typeof vi.fn>;
const expose = contextBridge.exposeInMainWorld as unknown as ReturnType<typeof vi.fn>;

function exposedFlow(): FlowApi {
  const call = expose.mock.calls.find(([name]) => name === 'flow');
  if (!call) throw new Error('the preload never exposed the flow namespace');
  return call[1] as FlowApi;
}

beforeEach(() => invoke.mockClear());

describe('window.flow.rebindHeldRun (§6)', () => {
  it('invokes flow:rebindHeldRun with the session id, the named worktree and the choice, and resolves the result', async () => {
    const flow = exposedFlow();
    invoke.mockResolvedValueOnce({ ok: true, outcome: 'resumed' });

    const res = await flow.rebindHeldRun('/repo-a', { origin: 'global', id: 'flow-b' });

    expect(invoke).toHaveBeenCalledWith('flow:rebindHeldRun', {
      sessionId: SESSION_ID,
      repoKey: '/repo-a',
      choice: { origin: 'global', id: 'flow-b' },
    });
    expect(res).toEqual({ ok: true, outcome: 'resumed' });
  });
});

describe('flow:rebindHeldRun payload validation (§6 — renderer-supplied input is untrusted)', () => {
  const msg = (choice: unknown, extra: Record<string, unknown> = {}): unknown => ({ sessionId: SESSION_ID, repoKey: '/repo', choice, ...extra });

  it('accepts every choice origin for a safe repoKey on the live session', () => {
    expect(isValid(msg({ origin: 'local' }))).toBe(true);
    expect(isValid(msg({ origin: 'fallback' }))).toBe(true);
    expect(isValid(msg({ origin: 'repo', id: 'flow-a' }))).toBe(true);
    expect(isValid(msg({ origin: 'global', id: 'flow-a' }))).toBe(true);
  });

  it('rejects an unknown origin, an unsafe or missing catalog id, extra keys, and a bad envelope', () => {
    expect(isValid(msg({ origin: 'elsewhere' }))).toBe(false);
    expect(isValid(msg({ origin: 'global' }))).toBe(false);
    expect(isValid(msg({ origin: 'global', id: '../escape' }))).toBe(false);
    expect(isValid(msg({ origin: 'repo', id: '' }))).toBe(false);
    expect(isValid(msg({ origin: 'local', id: 'flow-a' }))).toBe(false);
    expect(isValid(msg({ origin: 'fallback', extra: true }))).toBe(false);
    expect(isValid(msg({ origin: 'global', id: 'flow-a', tier: 'repo' }))).toBe(false);
    expect(isValid(msg({ origin: 'local' }, { tier: 'repo' }))).toBe(false);
    expect(isValid(msg({ origin: 'global', id: 42 }))).toBe(false);
    expect(isValid(msg({ origin: 'global', id: 'a'.repeat(MAX_CATALOG_ID_LENGTH + 1) }))).toBe(false);
    expect(isValid({ sessionId: SESSION_ID, repoKey: '/repo' })).toBe(false);
    expect(isValid(msg(null))).toBe(false);
    expect(isValid(msg('local'))).toBe(false);
    expect(isValid({ sessionId: SESSION_ID, repoKey: 'relative', choice: { origin: 'local' } })).toBe(false);
    expect(isValid({ sessionId: SESSION_ID, repoKey: '/repo/../etc', choice: { origin: 'local' } })).toBe(false);
    expect(isValid({ sessionId: 'other', repoKey: '/repo', choice: { origin: 'local' } })).toBe(false);
    expect(isValid({ sessionId: SESSION_ID, choice: { origin: 'local' } })).toBe(false);
    expect(isValid(null)).toBe(false);
  });
});
