// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  wireMonitorPane,
  FOCUS_TERMINAL_EVENT,
  REVEAL_CAPTURE_EVENT,
  REVEAL_HIGHLIGHT_MS,
  REVEAL_TERMINAL_EVENT,
  TODO_UNDO_MS,
  TODOS_CHANGED_EVENT,
} from '../../src/renderer/src/monitor';
import { DEFAULT_UI_SETTINGS } from '../../src/shared/ipc';
import type { CommandSummary, MonitorEvent, SelectionRange, TodoItem, UiSettings } from '../../src/shared/ipc';

/** A capture's on-screen span (absolute buffer rows), the cross-highlight coordinate (§16.8). */
function rangeRows(startRow: number, endRow: number): SelectionRange {
  return { start: { x: 0, y: startRow }, end: { x: 80, y: endRow }, baseY: 0, bufferType: 'normal' };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

// Canonical action-window DOM (§16.1) — mirrors src/renderer/index.html.
const MONITOR_HTML = `
  <div id="monitor-tabs" role="tablist">
    <button id="tab-capture" role="tab" aria-selected="true" aria-controls="panel-capture">
      Capture<span id="capture-unread" class="unread-dot" hidden></span>
    </button>
    <button id="tab-todo" role="tab" aria-selected="false" aria-controls="panel-todo">
      Todo <span id="todo-count" class="todo-count">0</span>
    </button>
  </div>
  <section id="panel-capture" role="tabpanel">
    <div id="monitor-status" role="status" aria-live="polite"></div>
    <div id="command-history"></div>
    <div id="monitor-blocks"></div>
  </section>
  <section id="panel-todo" role="tabpanel" hidden>
    <div id="todo-list"></div>
  </section>`;

function makeEvent(over: Partial<MonitorEvent>): MonitorEvent {
  return {
    id: 'e1',
    sessionId: 's1',
    type: 'capture',
    source: 'selection',
    text: 'hello',
    range: null,
    parentId: null,
    truncated: false,
    capturedAt: '2026-06-12T10:00:00.000Z',
    ...over,
  };
}

function makeCommand(over: Partial<CommandSummary>): CommandSummary {
  return {
    id: 'c1',
    sessionId: 's1',
    command: 'ls',
    exitCode: 0,
    running: false,
    startedAt: 0,
    truncated: false,
    ...over,
  };
}

function makeTodo(over: Partial<TodoItem>): TodoItem {
  return {
    id: 't1',
    repoKey: '/repo',
    text: 'todo',
    status: 'active',
    order: 1,
    createdAt: '2026-06-12T10:00:00.000Z',
    ...over,
  };
}

describe('action window DOM (§16 — tabs, captures, command history, focus)', () => {
  let handlers: {
    event?: (e: MonitorEvent) => void;
    update?: (m: unknown) => void;
    exit?: () => void;
    commandsChanged?: () => void;
    cwdChanged?: (m: { sessionId: string; cwd: string; repoKey: string }) => void;
    eventRemoved?: (eventId: string) => void;
  };
  let settings: UiSettings;
  let monitor: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    document.body.innerHTML = MONITOR_HTML;
    // jsdom does not implement scrollIntoView; shim it so the cross-highlight reveal
    // (§16.8) can call it. Also keeps stale listeners from prior wireMonitorPane() calls
    // (the shared jsdom window accumulates them) from throwing on dispatch.
    window.HTMLElement.prototype.scrollIntoView = () => {};
    handlers = {};
    settings = { ...DEFAULT_UI_SETTINGS };
    monitor = {
      onEvent: vi.fn((cb) => (handlers.event = cb)),
      onEventRemoved: vi.fn((cb) => (handlers.eventRemoved = cb)),
      onUpdate: vi.fn((cb) => (handlers.update = cb)),
      onExit: vi.fn((cb) => (handlers.exit = cb)),
      onCommandsChanged: vi.fn((cb) => (handlers.commandsChanged = cb)),
      onCwdChanged: vi.fn((cb) => (handlers.cwdChanged = cb)),
      currentRepo: vi.fn(async () => null),
      replay: vi.fn(async () => []),
      commands: vi.fn(async () => []),
      captureCommandText: vi.fn(async () => null),
      dismiss: vi.fn(),
      dismissAll: vi.fn(),
      learnChrome: vi.fn(),
      clearCommands: vi.fn(),
      inject: vi.fn(),
      getSettings: vi.fn(async () => settings),
      setSettings: vi.fn((patch) => Object.assign(settings, patch)),
      todoList: vi.fn(async () => []),
      todoAdd: vi.fn(async () => []),
      todoUpdate: vi.fn(async () => []),
      todoReorder: vi.fn(async () => []),
      todoSetStatus: vi.fn(async () => []),
      todoDelete: vi.fn(async () => []),
    };
    (window as unknown as { monitor: typeof monitor }).monitor = monitor;
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  const blocks = () => document.getElementById('monitor-blocks')!;
  const history = () => document.getElementById('command-history')!;
  const status = () => document.getElementById('monitor-status')!;
  const byId = (id: string) => document.getElementById(id)!;

  function announcedText(root: HTMLElement): string {
    const clone = root.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('[aria-hidden="true"]').forEach((n) => n.remove());
    return (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
  }

  // ---- tabs (§16.1) ----

  it('renders two tabs with Capture active by default', async () => {
    wireMonitorPane();
    await flush();
    expect(byId('tab-capture').getAttribute('aria-selected')).toBe('true');
    expect(byId('tab-todo').getAttribute('aria-selected')).toBe('false');
    expect(byId('panel-capture').hidden).toBe(false);
    expect(byId('panel-todo').hidden).toBe(true);
  });

  it('switches panels and persists the last tab when a tab is clicked', async () => {
    wireMonitorPane();
    await flush();
    (byId('tab-todo') as HTMLButtonElement).click();
    expect(byId('panel-todo').hidden).toBe(false);
    expect(byId('panel-capture').hidden).toBe(true);
    expect(byId('tab-todo').getAttribute('aria-selected')).toBe('true');
    expect(monitor.setSettings).toHaveBeenCalledWith({ lastTab: 'todo' });
  });

  it('restores the remembered last tab on load (global UiSettings.lastTab)', async () => {
    settings = { ...DEFAULT_UI_SETTINGS, lastTab: 'todo' };
    wireMonitorPane();
    await flush();
    expect(byId('panel-todo').hidden).toBe(false);
    expect(byId('tab-todo').getAttribute('aria-selected')).toBe('true');
  });

  it('shows an unread dot when an event arrives off the Capture tab, cleared on return', async () => {
    wireMonitorPane();
    await flush();
    (byId('tab-todo') as HTMLButtonElement).click();
    handlers.event!(makeEvent({ id: 'r', type: 'report', text: 'x' }));
    expect(byId('capture-unread').hidden).toBe(false);
    (byId('tab-capture') as HTMLButtonElement).click();
    expect(byId('capture-unread').hidden).toBe(true);
  });

  // ---- semantic captures: Add to todo + Dismiss, no inject (§16.2) ----

  it('a report group offers Add to todo + Dismiss and no Insert', async () => {
    wireMonitorPane();
    await flush();
    handlers.event!(makeEvent({ id: 'r', type: 'report', source: 'shadow-scan', text: 'whole report' }));
    const group = blocks().querySelector('[data-event-id="r"]') as HTMLElement;
    const buttons = Array.from(group.querySelectorAll('button')).map((b) => b.textContent);
    expect(buttons).toContain('Add to todo');
    expect(buttons.some((t) => t?.includes('Insert'))).toBe(false);
  });

  it('Mark as chrome on a block learns its glyphs and drops the block (§15.x)', async () => {
    wireMonitorPane();
    await flush();
    handlers.event!(makeEvent({ id: 'n', type: 'report', source: 'shadow-scan', text: '✻ Baked for 10m 58s' }));
    const block = blocks().querySelector('[data-event-id="n"]') as HTMLElement;
    const markBtn = Array.from(block.querySelectorAll('button')).find((b) => b.textContent === 'Mark as chrome')!;
    expect(markBtn).toBeTruthy();
    markBtn.click();
    expect(monitor.learnChrome).toHaveBeenCalledWith('n', '✻ Baked for 10m 58s');
    // Optimistic local removal mirrors Dismiss; main also retracts via monitor:eventRemoved.
    expect(blocks().querySelector('[data-event-id="n"]')).toBeNull();
  });

  it('Add to todo on a finding calls todoAdd and reveals Undo in place, leaving the block', async () => {
    wireMonitorPane();
    await flush();
    handlers.cwdChanged!({ sessionId: 's1', cwd: '/repo/src', repoKey: '/repo' });
    monitor.todoAdd.mockResolvedValue([makeTodo({ id: 'n1', repoKey: '/repo', text: 'finding one' })]);
    handlers.event!(makeEvent({ id: 'r', type: 'report', source: 'shadow-scan', text: 'report' }));
    handlers.event!(makeEvent({ id: 'f1', type: 'finding', parentId: 'r', text: 'finding one' }));
    const finding = blocks().querySelector('[data-event-id="f1"]') as HTMLElement;
    const addBtn = Array.from(finding.querySelectorAll('button')).find((b) => b.textContent === 'Add to todo')!;
    addBtn.click();
    await flush();
    expect(monitor.todoAdd).toHaveBeenCalledWith('/repo', 'finding one', { type: 'finding', eventId: 'f1' });
    // The block stays put until the undo window elapses; nothing dismissed yet.
    expect(blocks().querySelector('[data-event-id="f1"]')).toBeTruthy();
    expect(finding.querySelector('.undo-add-to-todo')).toBeTruthy();
    expect(monitor.dismiss).not.toHaveBeenCalled();
  });

  it('Undo on a just-added capture deletes the new todo, restores Add to todo, and never dismisses', async () => {
    wireMonitorPane();
    await flush();
    handlers.cwdChanged!({ sessionId: 's1', cwd: '/repo', repoKey: '/repo' });
    monitor.todoAdd.mockResolvedValue([makeTodo({ id: 'n1', repoKey: '/repo', text: 'a note' })]);
    monitor.todoDelete.mockResolvedValue([]);
    handlers.event!(makeEvent({ id: 'c1', type: 'capture', text: 'a note' }));
    const block = blocks().querySelector('[data-event-id="c1"]') as HTMLElement;
    Array.from(block.querySelectorAll('button')).find((b) => b.textContent === 'Add to todo')!.click();
    await flush();
    (block.querySelector('.undo-add-to-todo') as HTMLButtonElement).click();
    await flush();
    expect(monitor.todoDelete).toHaveBeenCalledWith('/repo', 'n1');
    expect(monitor.dismiss).not.toHaveBeenCalled();
    expect(block.querySelector('.undo-add-to-todo')).toBeNull();
    expect(Array.from(block.querySelectorAll('button')).some((b) => b.textContent === 'Add to todo')).toBe(true);
  });

  it('once the undo window elapses, the source block is dismissed and removed (§16.2)', async () => {
    vi.useFakeTimers();
    try {
      wireMonitorPane();
      await vi.advanceTimersByTimeAsync(0);
      handlers.cwdChanged!({ sessionId: 's1', cwd: '/repo', repoKey: '/repo' });
      monitor.todoAdd.mockResolvedValue([makeTodo({ id: 'n1', repoKey: '/repo', text: 'a note' })]);
      handlers.event!(makeEvent({ id: 'c1', type: 'capture', text: 'a note' }));
      const block = blocks().querySelector('[data-event-id="c1"]') as HTMLElement;
      Array.from(block.querySelectorAll('button')).find((b) => b.textContent === 'Add to todo')!.click();
      await vi.advanceTimersByTimeAsync(0);
      expect(blocks().querySelector('[data-event-id="c1"]')).toBeTruthy();
      await vi.advanceTimersByTimeAsync(TODO_UNDO_MS);
      expect(monitor.dismiss).toHaveBeenCalledWith('c1');
      expect(blocks().querySelector('[data-event-id="c1"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-pulls todos and updates the count when an external todo change is signaled (§16.2)', async () => {
    wireMonitorPane();
    await flush();
    handlers.cwdChanged!({ sessionId: 's1', cwd: '/repo', repoKey: '/repo' });
    await flush();
    expect(byId('todo-count').textContent).toBe('0');
    // A todo added elsewhere (e.g. the terminal pane's Capture selection button)
    // signals the change; the action window must re-pull and refresh its count.
    monitor.todoList.mockResolvedValue([
      makeTodo({ id: 't1', status: 'active' }),
      makeTodo({ id: 't2', status: 'active' }),
    ]);
    window.dispatchEvent(new CustomEvent(TODOS_CHANGED_EVENT));
    await flush();
    expect(monitor.todoList).toHaveBeenCalledWith('/repo');
    expect(byId('todo-count').textContent).toBe('2');
  });

  it('Add to todo updates the Todo tab active count from the returned list', async () => {
    monitor.todoAdd.mockResolvedValueOnce([makeTodo({ id: 't1', status: 'active' })]);
    wireMonitorPane();
    await flush();
    handlers.cwdChanged!({ sessionId: 's1', cwd: '/repo', repoKey: '/repo' });
    handlers.event!(makeEvent({ id: 'c', type: 'capture', text: 'note' }));
    const block = blocks().querySelector('[data-event-id="c"]') as HTMLElement;
    (Array.from(block.querySelectorAll('button')).find((b) => b.textContent === 'Add to todo')!).click();
    await flush();
    expect(byId('todo-count').textContent).toBe('1');
  });

  // ---- command history keeps inject + Clear commands (§16.2) ----

  it('a command-output block keeps Insert / Insert & submit actions', async () => {
    wireMonitorPane();
    await flush();
    handlers.event!(makeEvent({ type: 'command-output', source: 'shell-integration', text: 'hi' }));
    const buttons = blocks().querySelectorAll('.capture-actions button');
    expect(buttons.length).toBe(2);
    (buttons[1] as HTMLButtonElement).click();
    expect(monitor.inject).toHaveBeenCalledWith({ text: 'hi', submit: true });
  });

  it('Clear commands calls clearCommands() without optimistically wiping a running command', async () => {
    monitor.commands.mockResolvedValue([
      makeCommand({ id: 'c1', command: 'ls', exitCode: 0 }),
      makeCommand({ id: 'c2', command: 'sleep 5', running: true, exitCode: null }),
    ]);
    wireMonitorPane();
    await flush();
    const clear = byId('clear-commands') as HTMLButtonElement;
    expect(clear).toBeTruthy();
    clear.click();
    expect(monitor.clearCommands).toHaveBeenCalled();
    // No commandsChanged yet — the running command must stay visible (main is the source of truth).
    const texts = Array.from(history().querySelectorAll('.command-text')).map((e) => e.textContent);
    expect(texts).toContain('sleep 5');
  });

  it('Clear commands re-renders to only the still-running commands once main reports the change', async () => {
    monitor.commands.mockResolvedValue([
      makeCommand({ id: 'c1', command: 'ls', exitCode: 0 }),
      makeCommand({ id: 'c2', command: 'sleep 5', running: true, exitCode: null }),
    ]);
    wireMonitorPane();
    await flush();
    (byId('clear-commands') as HTMLButtonElement).click();
    monitor.commands.mockResolvedValue([makeCommand({ id: 'c2', command: 'sleep 5', running: true, exitCode: null })]);
    handlers.commandsChanged!();
    await flush();
    const entries = history().querySelectorAll('.command-entry');
    expect(entries.length).toBe(1);
    expect(entries[0].querySelector('.command-text')!.textContent).toBe('sleep 5');
  });

  it('renders command-history entries newest-first with exit chips and no per-entry Capture button', async () => {
    monitor.commands.mockResolvedValueOnce([
      makeCommand({ id: 'c1', command: 'ls', exitCode: 0 }),
      makeCommand({ id: 'c2', command: 'sleep 5', running: true, exitCode: null }),
    ]);
    wireMonitorPane();
    await flush();
    const entries = history().querySelectorAll('.command-entry');
    expect(entries.length).toBe(2);
    expect((entries[0] as HTMLElement).dataset.commandId).toBe('c2');
    expect(entries[1].querySelector('.command-text')!.textContent).toBe('ls');
    // Command capture moved to the Capture-selection button (§16.2); no per-entry button.
    expect(entries[0].querySelector('button')).toBeNull();
  });

  // ---- focus rule (§16.2) ----

  it('Insert moves focus to the terminal (fires the focus-terminal event); Insert & submit does not', async () => {
    wireMonitorPane();
    await flush();
    let focusFired = 0;
    window.addEventListener(FOCUS_TERMINAL_EVENT, () => focusFired++);
    handlers.event!(makeEvent({ type: 'command-output', source: 'shell-integration', text: 'hi' }));
    const buttons = blocks().querySelectorAll('.capture-actions button');
    (buttons[0] as HTMLButtonElement).click(); // Insert
    expect(focusFired).toBe(1);
    (buttons[1] as HTMLButtonElement).click(); // Insert & submit
    expect(focusFired).toBe(1); // unchanged — stays in the action window
  });

  // ---- preserved §15.6 behaviors ----

  it('renders a known type with a type badge', async () => {
    wireMonitorPane();
    await flush();
    handlers.event!(makeEvent({ type: 'command-output', text: 'Read(x)' }));
    const badge = blocks().querySelector('.capture-badge') as HTMLElement;
    expect(badge.dataset.type).toBe('command-output');
    expect(blocks().querySelector('.capture-text')!.textContent).toBe('Read(x)');
  });

  it('renders an unknown future type generically, never dropped', async () => {
    wireMonitorPane();
    await flush();
    handlers.event!(makeEvent({ type: 'mystery-type' as MonitorEvent['type'], text: 'x' }));
    const badge = blocks().querySelector('.capture-badge') as HTMLElement;
    expect(blocks().querySelectorAll('.capture-block').length).toBe(1);
    expect(badge.textContent).toContain('mystery-type');
  });

  it('re-pulls commands on each monitor:update tick (liveness)', async () => {
    wireMonitorPane();
    await flush();
    const callsAfterLoad = monitor.commands.mock.calls.length;
    handlers.update!({ sessionId: 's1', altScreen: false, bracketedPaste: false, agentState: 'quiet', quietSince: 1 });
    await flush();
    expect(monitor.commands.mock.calls.length).toBeGreaterThan(callsAfterLoad);
  });

  it('shows top-level blocks newest-first (v2.6)', async () => {
    wireMonitorPane();
    await flush();
    handlers.event!(makeEvent({ id: 'a', text: 'first' }));
    handlers.event!(makeEvent({ id: 'b', text: 'second' }));
    const els = blocks().querySelectorAll('.capture-block');
    expect((els[0] as HTMLElement).dataset.eventId).toBe('b');
    expect((els[1] as HTMLElement).dataset.eventId).toBe('a');
  });

  it('dismissing a block calls monitor.dismiss(id) and removes it from the DOM', async () => {
    wireMonitorPane();
    await flush();
    handlers.event!(makeEvent({ id: 'x', type: 'capture', text: 'bye' }));
    const block = blocks().querySelector('[data-event-id="x"]') as HTMLElement;
    (block.querySelector('.dismiss') as HTMLButtonElement).click();
    expect(monitor.dismiss).toHaveBeenCalledWith('x');
    expect(blocks().querySelector('[data-event-id="x"]')).toBeNull();
  });

  it('dismissing a report removes the whole group and cascades via dismiss(reportId)', async () => {
    wireMonitorPane();
    await flush();
    handlers.event!(makeEvent({ id: 'r', type: 'report', source: 'shadow-scan', text: 'report' }));
    handlers.event!(makeEvent({ id: 'f1', type: 'finding', parentId: 'r', text: 'one' }));
    const group = blocks().querySelector('[data-event-id="r"]') as HTMLElement;
    (group.querySelector('.dismiss') as HTMLButtonElement).click();
    expect(monitor.dismiss).toHaveBeenCalledWith('r');
    expect(blocks().querySelector('[data-event-id="r"]')).toBeNull();
    expect(blocks().querySelector('[data-event-id="f1"]')).toBeNull();
  });

  it('removes a block and its findings when main signals the capture was superseded (§15.3)', async () => {
    wireMonitorPane();
    await flush();
    handlers.event!(makeEvent({ id: 'r', type: 'report', source: 'shadow-scan', text: 'partial report' }));
    handlers.event!(makeEvent({ id: 'f1', type: 'finding', parentId: 'r', text: 'one' }));
    expect(blocks().querySelector('[data-event-id="r"]')).toBeTruthy();
    handlers.eventRemoved!('r');
    expect(blocks().querySelector('[data-event-id="r"]')).toBeNull();
    expect(blocks().querySelector('[data-event-id="f1"]')).toBeNull();
  });

  it('Dismiss all calls monitor.dismissAll() and clears every block', async () => {
    wireMonitorPane();
    await flush();
    handlers.event!(makeEvent({ id: 'a', text: 'one' }));
    handlers.event!(makeEvent({ id: 'b', text: 'two' }));
    const dismissAll = document.getElementById('dismiss-all') as HTMLButtonElement;
    expect(dismissAll).toBeTruthy();
    dismissAll.click();
    expect(monitor.dismissAll).toHaveBeenCalled();
    expect(blocks().querySelectorAll('.capture-block').length).toBe(0);
  });

  it('renders a stored event exactly once when replay and a live event carry the same id', async () => {
    monitor.replay.mockResolvedValueOnce([makeEvent({ id: 'dup', text: 'once' })]);
    wireMonitorPane();
    handlers.event!(makeEvent({ id: 'dup', text: 'once' }));
    await flush();
    expect(blocks().querySelectorAll('[data-event-id="dup"]').length).toBe(1);
  });

  it('does not re-announce the live status region on each quiet tick (WCAG 4.1.3)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-13T00:00:00.000Z'));
    try {
      wireMonitorPane();
      handlers.update!({
        sessionId: 's1',
        altScreen: false,
        bracketedPaste: false,
        agentState: 'quiet',
        quietSince: Date.now() - 3000,
      });
      const before = announcedText(status());
      expect(before).toContain('agent: quiet');
      expect(before).not.toMatch(/for \d+s/);
      vi.advanceTimersByTime(3000);
      expect(announcedText(status())).toBe(before);
      const counter = status().querySelector('[aria-hidden="true"]');
      expect(counter?.textContent).toMatch(/for \d+s/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders HTML metacharacters inert (textContent only, never innerHTML)', async () => {
    monitor.commands.mockResolvedValueOnce([makeCommand({ id: 'c1', command: '<b>&amp;</b>' })]);
    wireMonitorPane();
    await flush();
    handlers.event!(makeEvent({ text: '<script>alert(1)</script> & <img>' }));
    expect(blocks().querySelector('script')).toBeNull();
    expect(blocks().querySelector('.capture-text')!.textContent).toBe('<script>alert(1)</script> & <img>');
    expect(history().querySelector('b')).toBeNull();
    expect(history().querySelector('.command-text')!.textContent).toBe('<b>&amp;</b>');
  });

  // ---- cross-highlight between the terminal and the capture pane (§16.8) ----

  describe('capture ↔ terminal cross-highlight (§16.8)', () => {
    const blockById = (id: string) => blocks().querySelector(`[data-event-id="${id}"]`) as HTMLElement;

    it('a terminal double-click on a captured row scrolls to and highlights the covering block', async () => {
      wireMonitorPane();
      await flush();
      handlers.event!(makeEvent({ id: 'r', type: 'report', source: 'shadow-scan', text: 'a report', range: rangeRows(10, 14) }));
      const block = blockById('r');
      const scrollSpy = vi.spyOn(block, 'scrollIntoView');

      window.dispatchEvent(new CustomEvent(REVEAL_CAPTURE_EVENT, { detail: { row: 12 } }));

      expect(block.classList.contains('revealed')).toBe(true);
      expect(scrollSpy).toHaveBeenCalled();
    });

    it('the reveal highlight clears itself after REVEAL_HIGHLIGHT_MS', async () => {
      vi.useFakeTimers();
      try {
        wireMonitorPane();
        await vi.advanceTimersByTimeAsync(0);
        handlers.event!(makeEvent({ id: 'r', type: 'report', source: 'shadow-scan', text: 'rep', range: rangeRows(0, 4) }));
        const block = blockById('r');
        window.dispatchEvent(new CustomEvent(REVEAL_CAPTURE_EVENT, { detail: { row: 2 } }));
        expect(block.classList.contains('revealed')).toBe(true);
        await vi.advanceTimersByTimeAsync(REVEAL_HIGHLIGHT_MS);
        expect(block.classList.contains('revealed')).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('a terminal double-click on a row no capture covers highlights nothing', async () => {
      wireMonitorPane();
      await flush();
      handlers.event!(makeEvent({ id: 'r', type: 'report', source: 'shadow-scan', text: 'rep', range: rangeRows(10, 14) }));
      window.dispatchEvent(new CustomEvent(REVEAL_CAPTURE_EVENT, { detail: { row: 99 } }));
      expect(blocks().querySelector('.revealed')).toBeNull();
    });

    it('double-clicking a capture block asks the terminal to reveal its rows', async () => {
      wireMonitorPane();
      await flush();
      handlers.event!(makeEvent({ id: 'r', type: 'report', source: 'shadow-scan', text: 'rep', range: rangeRows(3, 7) }));
      let detail: { range: SelectionRange } | null = null;
      window.addEventListener(REVEAL_TERMINAL_EVENT, (e) => (detail = (e as CustomEvent).detail), { once: true });

      blockById('r').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

      expect(detail).toMatchObject({ range: { start: { y: 3 }, end: { y: 7 } } });
    });

    it("double-clicking a finding reveals the finding's own rows, not the whole report", async () => {
      wireMonitorPane();
      await flush();
      handlers.event!(makeEvent({ id: 'r', type: 'report', source: 'shadow-scan', text: 'rep', range: rangeRows(3, 7) }));
      handlers.event!(makeEvent({ id: 'f1', type: 'finding', parentId: 'r', text: 'one', range: rangeRows(5, 5) }));
      // Collect every reveal so a finding click that bubbled up to the report would be caught.
      const details: { range: SelectionRange }[] = [];
      window.addEventListener(REVEAL_TERMINAL_EVENT, (e) => details.push((e as CustomEvent).detail));

      (blocks().querySelector('[data-event-id="f1"]') as HTMLElement).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

      // Exactly the finding's span is revealed; the report's full span (…end.y 7) never is.
      expect(details.some((d) => d.range.start.y === 5 && d.range.end.y === 5)).toBe(true);
      expect(details.some((d) => d.range.end.y === 7)).toBe(false);
    });

    it('a terminal double-click inside a finding highlights that chunk, not the whole report', async () => {
      wireMonitorPane();
      await flush();
      handlers.event!(makeEvent({ id: 'r', type: 'report', source: 'shadow-scan', text: 'rep', range: rangeRows(3, 7) }));
      handlers.event!(makeEvent({ id: 'f1', type: 'finding', parentId: 'r', text: 'one', range: rangeRows(5, 5) }));

      window.dispatchEvent(new CustomEvent(REVEAL_CAPTURE_EVENT, { detail: { row: 5 } }));

      expect((blocks().querySelector('[data-event-id="f1"]') as HTMLElement).classList.contains('revealed')).toBe(true);
      // The chunk is revealed specifically — the enclosing report block is not the target.
      expect(blockById('r').classList.contains('revealed')).toBe(false);
    });

    it('a reveal skips a dismissed block whose range lingers and highlights the live one', async () => {
      wireMonitorPane();
      await flush();
      // A captured at rows 10–14, then dismissed via its × (removed from the DOM directly,
      // so its range entry is not cleaned up by removeBlock).
      handlers.event!(makeEvent({ id: 'a', type: 'report', source: 'shadow-scan', text: 'old', range: rangeRows(10, 14) }));
      (blockById('a').querySelector('.dismiss') as HTMLButtonElement).click();
      // A new capture reuses the same rows.
      handlers.event!(makeEvent({ id: 'b', type: 'report', source: 'shadow-scan', text: 'new', range: rangeRows(10, 14) }));
      const b = blockById('b');

      window.dispatchEvent(new CustomEvent(REVEAL_CAPTURE_EVENT, { detail: { row: 12 } }));

      expect(b.classList.contains('revealed')).toBe(true);
    });

    it('double-clicking a block with no range (manual capture) asks for nothing', async () => {
      wireMonitorPane();
      await flush();
      handlers.event!(makeEvent({ id: 'c', type: 'capture', text: 'manual', range: null }));
      let fired = false;
      window.addEventListener(REVEAL_TERMINAL_EVENT, () => (fired = true), { once: true });
      blockById('c').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      expect(fired).toBe(false);
    });
  });
});
