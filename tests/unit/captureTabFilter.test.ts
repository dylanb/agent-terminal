// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCaptureTab } from '../../src/renderer/src/captureTab';
import type { MonitorEvent, MonitorEventType } from '../../src/shared/ipc';

function makeEvent(type: MonitorEventType, over: Partial<MonitorEvent> = {}): MonitorEvent {
  return {
    id: `${type}-1`,
    sessionId: 's1',
    type,
    source: 'shadow-scan',
    text: `${type} body text`,
    range: null,
    parentId: null,
    truncated: false,
    capturedAt: new Date(0).toISOString(),
    ...over,
  };
}

describe('Capture pane rendering filter (§15.x — tool-call furniture is not a capture card)', () => {
  let blocksEl: HTMLElement;
  let historyEl: HTMLElement;

  function makeTab() {
    blocksEl = document.createElement('div');
    historyEl = document.createElement('div');
    return createCaptureTab({
      blocksEl,
      historyEl,
      monitor: { dismiss: vi.fn(), dismissAll: vi.fn(), clearCommands: vi.fn(), learnChrome: vi.fn() },
      todoSink: {
        currentRepoKey: () => '/repo',
        addFromCapture: vi.fn(async () => ({ repoKey: '/repo', id: 't1' })),
        deleteTodo: vi.fn(async () => {}),
      } as never,
    });
  }

  afterEach(() => vi.restoreAllMocks());

  it('renders report blocks but never renders tool-use or diff blocks (they only carve report text, §15.x)', () => {
    const tab = makeTab();
    tab.appendBlock(makeEvent('report'));
    tab.appendBlock(makeEvent('tool-use'));
    tab.appendBlock(makeEvent('diff'));

    const blocks = blocksEl.querySelectorAll('.capture-block');
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as HTMLElement).dataset.type).toBe('report');
    expect(blocksEl.querySelector('[data-type="tool-use"]')).toBeNull();
    expect(blocksEl.querySelector('[data-type="diff"]')).toBeNull();
  });
});
