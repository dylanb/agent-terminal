// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCaptureTab } from '../../src/renderer/src/captureTab';
import { TODO_UNDO_MS } from '../../src/renderer/src/paneActions';
import type { MonitorEvent, MonitorEventType } from '../../src/shared/ipc';

function makeEvent(type: MonitorEventType, over: Partial<MonitorEvent> = {}): MonitorEvent {
  return {
    id: `${type}-1`,
    sessionId: 's1',
    type,
    source: 'shadow-scan',
    text: `${type} body`,
    range: null,
    parentId: null,
    truncated: false,
    capturedAt: new Date(0).toISOString(),
    ...over,
  };
}

describe('Capture pane chunks: checkbox selection + bulk Add to todo / Dismiss selected (§16.2)', () => {
  let container: HTMLElement;
  let blocksEl: HTMLElement;
  let dismissed: string[];
  let added: { text: string }[];
  let deleted: { repoKey: string; id: string }[];

  function makeTab() {
    dismissed = [];
    added = [];
    deleted = [];
    container = document.createElement('div');
    blocksEl = document.createElement('div');
    const historyEl = document.createElement('div');
    container.append(historyEl, blocksEl);
    document.body.appendChild(container);
    return createCaptureTab({
      blocksEl,
      historyEl,
      monitor: {
        dismiss: vi.fn((id: string) => dismissed.push(id)),
        dismissAll: vi.fn(),
        clearCommands: vi.fn(),
        learnChrome: vi.fn(),
      },
      todoSink: {
        currentRepoKey: () => '/repo',
        addFromCapture: vi.fn(async (text: string) => {
          added.push({ text });
          return { repoKey: '/repo', id: 'new1' } as never;
        }),
        deleteTodo: vi.fn(async (repoKey: string, id: string) => {
          deleted.push({ repoKey, id });
        }),
      } as never,
    });
  }

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  const addBtn = () => container.querySelector('#add-selected-todo') as HTMLButtonElement;
  const dismissSelBtn = () => container.querySelector('#dismiss-selected') as HTMLButtonElement;
  const checks = () => Array.from(blocksEl.querySelectorAll<HTMLInputElement>('.chunk-check'));
  const findingEl = (id: string) => blocksEl.querySelector(`.finding[data-event-id="${id}"]`) as HTMLElement;

  it('renders a checkbox per finding and no per-finding Add-to-todo or × buttons', () => {
    const tab = makeTab();
    tab.appendBlock(makeEvent('report', { id: 'r' }));
    tab.appendBlock(makeEvent('finding', { id: 'f1', parentId: 'r', text: 'finding one' }));

    const f = findingEl('f1');
    expect(f.querySelector('.chunk-check')).toBeTruthy();
    const labels = Array.from(f.querySelectorAll('button')).map((b) => b.textContent);
    expect(labels).not.toContain('Add to todo');
    expect(labels).not.toContain('×');
  });

  it('gives a report with no findings its own checkbox (it is the chunk)', () => {
    const tab = makeTab();
    tab.appendBlock(makeEvent('report', { id: 'r', text: 'whole report' }));
    const block = blocksEl.querySelector('[data-event-id="r"]') as HTMLElement;
    expect(block.querySelector('.chunk-check')).toBeTruthy();
  });

  it('bulk Add to todo concatenates the checked chunks in appeared order, blank-line separated', async () => {
    const tab = makeTab();
    tab.appendBlock(makeEvent('report', { id: 'r' }));
    tab.appendBlock(makeEvent('finding', { id: 'f1', parentId: 'r', text: 'first chunk' }));
    tab.appendBlock(makeEvent('finding', { id: 'f2', parentId: 'r', text: 'second chunk' }));

    // Check in reverse order to prove output follows appeared order, not click order.
    const byId = (id: string) => findingEl(id).querySelector<HTMLInputElement>('.chunk-check')!;
    byId('f2').checked = true;
    byId('f2').dispatchEvent(new Event('change', { bubbles: true }));
    byId('f1').checked = true;
    byId('f1').dispatchEvent(new Event('change', { bubbles: true }));

    addBtn().click();
    await Promise.resolve();
    expect(added).toEqual([{ text: 'first chunk\n\nsecond chunk' }]);
    expect(container.querySelector('.undo-add-to-todo')).toBeTruthy();
  });

  it('Add-to-todo and Dismiss-selected are disabled until at least one chunk is checked', () => {
    const tab = makeTab();
    tab.appendBlock(makeEvent('report', { id: 'r' }));
    tab.appendBlock(makeEvent('finding', { id: 'f1', parentId: 'r', text: 'one' }));
    expect(addBtn().disabled).toBe(true);
    expect(dismissSelBtn().disabled).toBe(true);

    const c = checks()[0];
    c.checked = true;
    c.dispatchEvent(new Event('change', { bubbles: true }));
    expect(addBtn().disabled).toBe(false);
    expect(dismissSelBtn().disabled).toBe(false);
  });

  it('once the undo window elapses, the added chunks are dismissed', async () => {
    vi.useFakeTimers();
    try {
      const tab = makeTab();
      tab.appendBlock(makeEvent('report', { id: 'r' }));
      tab.appendBlock(makeEvent('finding', { id: 'f1', parentId: 'r', text: 'one' }));
      tab.appendBlock(makeEvent('finding', { id: 'f2', parentId: 'r', text: 'two' }));
      for (const c of checks()) {
        c.checked = true;
        c.dispatchEvent(new Event('change', { bubbles: true }));
      }
      addBtn().click();
      await vi.advanceTimersByTimeAsync(0);
      expect(dismissed).toEqual([]); // not yet committed
      await vi.advanceTimersByTimeAsync(TODO_UNDO_MS);
      expect(dismissed.sort()).toEqual(['f1', 'f2']);
      expect(findingEl('f1')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('Undo deletes the just-added todo and leaves the chunks (nothing dismissed)', async () => {
    const tab = makeTab();
    tab.appendBlock(makeEvent('report', { id: 'r' }));
    tab.appendBlock(makeEvent('finding', { id: 'f1', parentId: 'r', text: 'one' }));
    const c = checks()[0];
    c.checked = true;
    c.dispatchEvent(new Event('change', { bubbles: true }));
    addBtn().click();
    await Promise.resolve();
    (container.querySelector('.undo-add-to-todo') as HTMLButtonElement).click();
    await Promise.resolve();
    expect(deleted).toEqual([{ repoKey: '/repo', id: 'new1' }]);
    expect(dismissed).toEqual([]);
    expect(findingEl('f1')).toBeTruthy();
  });

  it('dims the added chunks and disables their checkboxes during the undo window', async () => {
    const tab = makeTab();
    tab.appendBlock(makeEvent('report', { id: 'r' }));
    tab.appendBlock(makeEvent('finding', { id: 'f1', parentId: 'r', text: 'one' }));
    const cb = findingEl('f1').querySelector<HTMLInputElement>('.chunk-check')!;
    cb.checked = true;
    cb.dispatchEvent(new Event('change', { bubbles: true }));

    addBtn().click();
    await Promise.resolve();
    expect(findingEl('f1').classList.contains('chunk-processed')).toBe(true);
    expect(cb.disabled).toBe(true);
  });

  it('Undo restores the dimmed chunks to interactive (not processed, enabled)', async () => {
    const tab = makeTab();
    tab.appendBlock(makeEvent('report', { id: 'r' }));
    tab.appendBlock(makeEvent('finding', { id: 'f1', parentId: 'r', text: 'one' }));
    const cb = findingEl('f1').querySelector<HTMLInputElement>('.chunk-check')!;
    cb.checked = true;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    addBtn().click();
    await Promise.resolve();

    (container.querySelector('.undo-add-to-todo') as HTMLButtonElement).click();
    await Promise.resolve();
    expect(findingEl('f1').classList.contains('chunk-processed')).toBe(false);
    expect(cb.disabled).toBe(false);
  });

  it('Dismiss selected dismisses the checked chunks immediately', () => {
    const tab = makeTab();
    tab.appendBlock(makeEvent('report', { id: 'r' }));
    tab.appendBlock(makeEvent('finding', { id: 'f1', parentId: 'r', text: 'one' }));
    tab.appendBlock(makeEvent('finding', { id: 'f2', parentId: 'r', text: 'two' }));
    findingEl('f1').querySelector<HTMLInputElement>('.chunk-check')!.checked = true;
    findingEl('f1').querySelector<HTMLInputElement>('.chunk-check')!.dispatchEvent(new Event('change', { bubbles: true }));

    dismissSelBtn().click();
    expect(dismissed).toEqual(['f1']);
    expect(findingEl('f1')).toBeNull();
    expect(findingEl('f2')).toBeTruthy();
  });
});
