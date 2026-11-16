import { afterEach, describe, expect, it, vi } from 'vitest';
import '../../src/renderer/src/tokens.css';
import '../../src/renderer/src/styles.css';
import { createFlowStrip } from '../../src/renderer/src/flowStrip';
import type { FlowStateView } from '../../src/shared/ipc';

afterEach(() => {
  document.body.replaceChildren();
});

describe('the flow strip while Waiting, as painted (#319 AC11)', () => {
  it('shows the program label in its own case', async () => {
    const host = document.createElement('div');
    host.className = 'blk flowstrip';
    document.body.append(host);
    const view: FlowStateView = {
      stepName: '/repo-step', runStarted: 'never-started' as const, steps: ['/repo-step'], position: 1, total: 1, status: 'in_progress',
      derived: { activity: 'quiet', waiting: { program: 'MainThread', others: 1 }, todosDone: 1, todosTotal: 2, ready: false },
    };
    createFlowStrip(host, {
      state: vi.fn(async () => view), start: vi.fn(), advance: vi.fn(), restart: vi.fn(), undo: vi.fn(), terminate: vi.fn(),
      provideInput: vi.fn(), onStatusBar: vi.fn(), onStateChanged: vi.fn(() => () => {}),
    }).onRepoChanged('/repo');
    const line = await vi.waitFor(() => {
      const found = host.querySelector<HTMLElement>('.flow-derived');
      if (!found) throw new Error('no derived line yet');
      return found;
    });
    expect(line.innerText).toMatch(/\bMainThread \+1\b/);
  });
});
