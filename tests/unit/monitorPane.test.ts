// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  wireMonitorPane,
  CAPTURE_RANGE_ADD_EVENT,
  CAPTURE_RANGE_REMOVE_EVENT,
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

  it('a report chunk carries a checkbox; the toolbar offers Add to todo, never Insert', async () => {
    wireMonitorPane();
    await flush();
    handlers.event!(makeEvent({ id: 'r', type: 'report', source: 'shadow-scan', text: 'whole report' }));
    const group = blocks().querySelector('[data-event-id="r"]') as HTMLElement;
    expect(group.querySelector('.chunk-check')).toBeTruthy();
    expect(byId('add-selected-todo').textContent).toBe('Add to todo');
    const capturePanelButtons = Array.from(byId('panel-capture').querySelectorAll('button')).map((b) => b.textContent);
    expect(capturePanelButtons.some((t) => t?.includes('Insert'))).toBe(false);
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

  function checkChunk(eventId: string): void {
    const cb = blocks().querySelector(`[data-event-id="${eventId}"] .chunk-check`) as HTMLInputElement;
    cb.checked = true;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
  }

  it('checking a finding + bulk Add to todo calls todoAdd and reveals Undo, leaving the chunk', async () => {
    wireMonitorPane();
    await flush();
    handlers.cwdChanged!({ sessionId: 's1', cwd: '/repo/src', repoKey: '/repo' });
    monitor.todoAdd.mockResolvedValue([makeTodo({ id: 'n1', repoKey: '/repo', text: 'finding one' })]);
    handlers.event!(makeEvent({ id: 'r', type: 'report', source: 'shadow-scan', text: 'report' }));
    handlers.event!(makeEvent({ id: 'f1', type: 'finding', parentId: 'r', text: 'finding one' }));
    checkChunk('f1');
    (byId('add-selected-todo') as HTMLButtonElement).click();
    await flush();
    expect(monitor.todoAdd).toHaveBeenCalledWith('/repo', 'finding one', { type: 'capture' });
    // The chunk stays put until the undo window elapses; nothing dismissed yet.
    expect(blocks().querySelector('[data-event-id="f1"]')).toBeTruthy();
    expect(byId('panel-capture').querySelector('.undo-add-to-todo')).toBeTruthy();
    expect(monitor.dismiss).not.toHaveBeenCalled();
  });

  it('Undo after bulk add deletes the new todo, restores Add to todo, and never dismisses', async () => {
    wireMonitorPane();
    await flush();
    handlers.cwdChanged!({ sessionId: 's1', cwd: '/repo', repoKey: '/repo' });
    monitor.todoAdd.mockResolvedValue([makeTodo({ id: 'n1', repoKey: '/repo', text: 'a note' })]);
    monitor.todoDelete.mockResolvedValue([]);
    handlers.event!(makeEvent({ id: 'c1', type: 'capture', text: 'a note' }));
    checkChunk('c1');
    (byId('add-selected-todo') as HTMLButtonElement).click();
    await flush();
    (byId('panel-capture').querySelector('.undo-add-to-todo') as HTMLButtonElement).click();
    await flush();
    expect(monitor.todoDelete).toHaveBeenCalledWith('/repo', 'n1');
    expect(monitor.dismiss).not.toHaveBeenCalled();
    expect(byId('panel-capture').querySelector('.undo-add-to-todo')).toBeNull();
    expect((byId('add-selected-todo') as HTMLButtonElement).hidden).toBe(false);
  });

  it('once the bulk-add undo window elapses, the checked chunks are dismissed and removed (§16.2)', async () => {
    vi.useFakeTimers();
    try {
      wireMonitorPane();
      await vi.advanceTimersByTimeAsync(0);
      handlers.cwdChanged!({ sessionId: 's1', cwd: '/repo', repoKey: '/repo' });
      monitor.todoAdd.mockResolvedValue([makeTodo({ id: 'n1', repoKey: '/repo', text: 'a note' })]);
      handlers.event!(makeEvent({ id: 'c1', type: 'capture', text: 'a note' }));
      checkChunk('c1');
      (byId('add-selected-todo') as HTMLButtonElement).click();
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

  it('bulk Add to todo updates the Todo tab active count from the returned list', async () => {
    monitor.todoAdd.mockResolvedValueOnce([makeTodo({ id: 't1', status: 'active' })]);
    wireMonitorPane();
    await flush();
    handlers.cwdChanged!({ sessionId: 's1', cwd: '/repo', repoKey: '/repo' });
    handlers.event!(makeEvent({ id: 'c', type: 'capture', text: 'note' }));
    checkChunk('c');
    (byId('add-selected-todo') as HTMLButtonElement).click();
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

  it('Dismiss selected dismisses a checked block via monitor.dismiss(id) and removes it', async () => {
    wireMonitorPane();
    await flush();
    handlers.event!(makeEvent({ id: 'x', type: 'capture', text: 'bye' }));
    checkChunk('x');
    (byId('dismiss-selected') as HTMLButtonElement).click();
    expect(monitor.dismiss).toHaveBeenCalledWith('x');
    expect(blocks().querySelector('[data-event-id="x"]')).toBeNull();
  });

  it('Dismiss selected on a report-without-findings cascades via dismiss(reportId) and removes it', async () => {
    wireMonitorPane();
    await flush();
    handlers.event!(makeEvent({ id: 'r', type: 'report', source: 'shadow-scan', text: 'report' }));
    checkChunk('r');
    (byId('dismiss-selected') as HTMLButtonElement).click();
    expect(monitor.dismiss).toHaveBeenCalledWith('r'); // main cascades to child findings (§15.6)
    expect(blocks().querySelector('[data-event-id="r"]')).toBeNull();
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

    // Terminal → capture is now id-keyed: the terminal pane owns the coordinates (marker-
    // anchored, §16.8) and resolves the double-clicked row to a capture id, which it sends
    // here. The pane just reveals that exact element. The row→id matching is unit-tested
    // separately against pickRevealTarget (tests/unit/reveal.test.ts).
    it('reveals the block named by app:reveal-capture {id}: scrolls to + highlights it', async () => {
      wireMonitorPane();
      await flush();
      handlers.event!(makeEvent({ id: 'r', type: 'report', source: 'shadow-scan', text: 'a report', range: rangeRows(10, 14) }));
      const block = blockById('r');
      const scrollSpy = vi.spyOn(block, 'scrollIntoView');

      window.dispatchEvent(new CustomEvent(REVEAL_CAPTURE_EVENT, { detail: { id: 'r' } }));

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
        window.dispatchEvent(new CustomEvent(REVEAL_CAPTURE_EVENT, { detail: { id: 'r' } }));
        expect(block.classList.contains('revealed')).toBe(true);
        await vi.advanceTimersByTimeAsync(REVEAL_HIGHLIGHT_MS);
        expect(block.classList.contains('revealed')).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('an app:reveal-capture for an id with no rendered block highlights nothing', async () => {
      wireMonitorPane();
      await flush();
      handlers.event!(makeEvent({ id: 'r', type: 'report', source: 'shadow-scan', text: 'rep', range: rangeRows(10, 14) }));
      window.dispatchEvent(new CustomEvent(REVEAL_CAPTURE_EVENT, { detail: { id: 'gone' } }));
      expect(blocks().querySelector('.revealed')).toBeNull();
    });

    // Capture → terminal: the pane publishes the capture's span when it renders (so the
    // terminal can marker-anchor it) and asks for a reveal by id on double-click.
    it('publishes a ranged block as app:capture-range-add {id, range}', async () => {
      wireMonitorPane();
      await flush();
      let detail: { id: string; range: SelectionRange } | null = null;
      window.addEventListener(CAPTURE_RANGE_ADD_EVENT, (e) => (detail = (e as CustomEvent).detail), { once: true });

      handlers.event!(makeEvent({ id: 'r', type: 'report', source: 'shadow-scan', text: 'rep', range: rangeRows(3, 7) }));

      expect(detail).toMatchObject({ id: 'r', range: { start: { y: 3 }, end: { y: 7 } } });
    });

    it('publishes each finding with its own span', async () => {
      wireMonitorPane();
      await flush();
      const adds: { id: string; range: SelectionRange }[] = [];
      window.addEventListener(CAPTURE_RANGE_ADD_EVENT, (e) => adds.push((e as CustomEvent).detail));

      handlers.event!(makeEvent({ id: 'r', type: 'report', source: 'shadow-scan', text: 'rep', range: rangeRows(3, 7) }));
      handlers.event!(makeEvent({ id: 'f1', type: 'finding', parentId: 'r', text: 'one', range: rangeRows(5, 5) }));

      expect(adds.some((d) => d.id === 'f1' && d.range.start.y === 5 && d.range.end.y === 5)).toBe(true);
    });

    it('a manual capture with no range publishes no span', async () => {
      wireMonitorPane();
      await flush();
      let fired = false;
      window.addEventListener(CAPTURE_RANGE_ADD_EVENT, () => (fired = true), { once: true });
      handlers.event!(makeEvent({ id: 'c', type: 'capture', text: 'manual', range: null }));
      expect(fired).toBe(false);
    });

    it('retracting a block publishes app:capture-range-remove {id}', async () => {
      wireMonitorPane();
      await flush();
      handlers.event!(makeEvent({ id: 'r', type: 'report', source: 'shadow-scan', text: 'rep', range: rangeRows(3, 7) }));
      let detail: { id: string } | null = null;
      window.addEventListener(CAPTURE_RANGE_REMOVE_EVENT, (e) => (detail = (e as CustomEvent).detail), { once: true });

      handlers.eventRemoved!('r');

      expect(detail).toEqual({ id: 'r' });
    });

    it('Dismiss selected publishes capture-range-remove for the dismissed chunk', async () => {
      wireMonitorPane();
      await flush();
      handlers.event!(makeEvent({ id: 'r', type: 'report', source: 'shadow-scan', text: 'rep', range: rangeRows(3, 7) }));
      const removed: string[] = [];
      window.addEventListener(CAPTURE_RANGE_REMOVE_EVENT, (e) => removed.push((e as CustomEvent).detail.id));
      const cb = blockById('r').querySelector('.chunk-check') as HTMLInputElement;
      cb.checked = true;
      cb.dispatchEvent(new Event('change', { bubbles: true }));

      (byId('dismiss-selected') as HTMLButtonElement).click();

      expect(removed).toContain('r');
    });

    it('double-clicking a capture block asks the terminal to reveal it by id', async () => {
      wireMonitorPane();
      await flush();
      handlers.event!(makeEvent({ id: 'r', type: 'report', source: 'shadow-scan', text: 'rep', range: rangeRows(3, 7) }));
      let detail: { id: string } | null = null;
      window.addEventListener(REVEAL_TERMINAL_EVENT, (e) => (detail = (e as CustomEvent).detail), { once: true });

      blockById('r').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

      expect(detail).toEqual({ id: 'r' });
    });

    it("double-clicking a finding reveals the finding's own id, not the report's", async () => {
      wireMonitorPane();
      await flush();
      handlers.event!(makeEvent({ id: 'r', type: 'report', source: 'shadow-scan', text: 'rep', range: rangeRows(3, 7) }));
      handlers.event!(makeEvent({ id: 'f1', type: 'finding', parentId: 'r', text: 'one', range: rangeRows(5, 5) }));
      // Collect every reveal so a finding click that bubbled up to the report would be caught.
      const ids: string[] = [];
      window.addEventListener(REVEAL_TERMINAL_EVENT, (e) => ids.push((e as CustomEvent).detail.id));

      (blocks().querySelector('[data-event-id="f1"]') as HTMLElement).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

      expect(ids).toContain('f1');
      expect(ids).not.toContain('r');
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
