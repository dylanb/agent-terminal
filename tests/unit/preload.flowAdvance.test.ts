import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { on: vi.fn(), removeListener: vi.fn(), send: vi.fn(), invoke: vi.fn() },
  webUtils: { getPathForFile: vi.fn() },
}));

import { contextBridge, ipcRenderer } from 'electron';
import '../../src/preload/index';
import { isValidFlowAdvance } from '../../src/main/ipcValidation';
import { SESSION_ID, type FlowApi } from '../../src/shared/ipc';

const invoke = ipcRenderer.invoke as unknown as ReturnType<typeof vi.fn>;
const expose = contextBridge.exposeInMainWorld as unknown as ReturnType<typeof vi.fn>;

function exposedFlow(): FlowApi {
  const call = expose.mock.calls.find(([name]) => name === 'flow');
  if (!call) throw new Error('the preload never exposed the flow namespace');
  return call[1] as FlowApi;
}

beforeEach(() => invoke.mockClear());

describe('window.flow.advance (§6)', () => {
  it('advances without a step, sending a request main accepts', async () => {
    invoke.mockResolvedValueOnce({ stepName: 'green' });

    await exposedFlow().advance('/repo');

    const [channel, payload] = invoke.mock.calls[0];
    expect(channel).toBe('flow:advance');
    expect(payload).toMatchObject({ sessionId: SESSION_ID, repoKey: '/repo' });
    expect(isValidFlowAdvance(payload)).toBe(true);
  });

  it('advances naming the step the strip showed', async () => {
    invoke.mockResolvedValueOnce({ stepName: 'green' });

    await exposedFlow().advance('/repo', 'red');

    const [, payload] = invoke.mock.calls[0];
    expect(payload).toMatchObject({ sessionId: SESSION_ID, repoKey: '/repo', step: 'red' });
    expect(isValidFlowAdvance(payload)).toBe(true);
  });
});
