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

  function makeTab() {
    blocksEl = document.createElement('div');
    return createCaptureTab({
      blocksEl,
      todoSink: {
        currentRepoKey: () => '/repo',
        addFromCapture: vi.fn(async () => null),
      } as never,
    });
  }

  afterEach(() => vi.restoreAllMocks());

  it('renders actionable findings but never report blobs, tool-use, or diff (§15.x / §24.1)', () => {
    const tab = makeTab();
    tab.appendBlock(makeEvent('finding'));
    tab.appendBlock(makeEvent('report')); // carved into findings; the blob itself is not a card
    tab.appendBlock(makeEvent('tool-use'));
    tab.appendBlock(makeEvent('diff'));

    const cards = blocksEl.querySelectorAll('.finding');
    expect(cards).toHaveLength(1);
    expect(cards[0].querySelector('.t')!.textContent).toBe('finding body text');
  });
});
