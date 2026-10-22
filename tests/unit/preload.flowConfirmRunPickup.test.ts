import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { on: vi.fn(), removeListener: vi.fn(), send: vi.fn(), invoke: vi.fn() },
  webUtils: { getPathForFile: vi.fn() },
}));

import { contextBridge, ipcRenderer } from 'electron';
import '../../src/preload/index';
import { isValidFlowConfirmRunPickup as isValid } from '../../src/main/ipcValidation';
import { SESSION_ID, type FlowApi } from '../../src/shared/ipc';

// §27.13 v2.211 §6 — `flow:confirmRunPickup` names the worktree and the run whose hold it releases, and the numbers
// the operator confirmed; main rejects any other shape before it asks GitHub anything.

const invoke = ipcRenderer.invoke as unknown as ReturnType<typeof vi.fn>;
const expose = contextBridge.exposeInMainWorld as unknown as ReturnType<typeof vi.fn>;

function exposedFlow(): FlowApi {
  const call = expose.mock.calls.find(([name]) => name === 'flow');
  if (!call) throw new Error('the preload never exposed the flow namespace');
  return call[1] as FlowApi;
}

const RUN = { flow: 'feature-dev-v3', startedAt: 1792407818398 };

beforeEach(() => invoke.mockClear());

describe('window.flow.confirmRunPickup (§6)', () => {
  it('invokes flow:confirmRunPickup with the session, the worktree, the run and the confirmed numbers, and resolves the result', async () => {
    invoke.mockResolvedValueOnce({ ok: false, reason: 'pull request #233 does not close ticket #300' });

    const res = await exposedFlow().confirmRunPickup('/repo-a', RUN, 233, 300);

    expect(invoke).toHaveBeenCalledWith('flow:confirmRunPickup', { sessionId: SESSION_ID, repoKey: '/repo-a', run: RUN, pr: 233, ticket: 300 });
    expect(res).toEqual({ ok: false, reason: 'pull request #233 does not close ticket #300' });
  });
});

describe('flow:confirmRunPickup payload validation (§6 — renderer-supplied input is untrusted)', () => {
  const msg = (over: Record<string, unknown> = {}): unknown => ({ sessionId: SESSION_ID, repoKey: '/repo', run: RUN, pr: 233, ticket: 218, ...over });

  it('accepts a well-formed confirm on the live session', () => {
    expect(isValid(msg())).toBe(true);
  });

  it.each([
    ['another session', { sessionId: 'other' }],
    ['a relative repoKey', { repoKey: 'repo' }],
    ['no run', { run: undefined }],
    ['a run without its start', { run: { flow: 'feature-dev-v3' } }],
    ['a run with a non-numeric start', { run: { flow: 'feature-dev-v3', startedAt: '1' } }],
    ['a run with an extra key', { run: { ...RUN, step: 'plan' } }],
    ['a zero PR', { pr: 0 }],
    ['a fractional PR', { pr: 2.5 }],
    ['a PR beyond the safe integers', { pr: 2 ** 53 }],
    ['a string ticket', { ticket: '218' }],
    ['a negative ticket', { ticket: -1 }],
    ['an extra key', { branch: 'main' }],
  ])('rejects %s', (_name, over) => {
    expect(isValid(msg(over))).toBe(false);
  });
});
