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
  TODOS_CHANGED_EVENT,
} from '../../src/renderer/src/monitor';
import { DEFAULT_UI_SETTINGS } from '../../src/shared/ipc';
import type { MonitorEvent, SelectionRange, TodoItem, UiSettings } from '../../src/shared/ipc';

/** A capture's on-screen span (absolute buffer rows), the cross-highlight coordinate (§16.8). */
function rangeRows(startRow: number, endRow: number): SelectionRange {
  return { start: { x: 0, y: startRow }, end: { x: 80, y: endRow }, baseY: 0, bufferType: 'normal' };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

// Canonical action-window DOM (§16.1 / §24.1) — mirrors src/renderer/index.html.
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
    <button id="capture-last">Capture last report</button>
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

describe('action window DOM (§16 / §24.1 — tabs, capture cards, focus)', () => {
  let handlers: {
    event?: (e: MonitorEvent) => void;
    update?: (m: unknown) => void;
    exit?: () => void;
    cwdChanged?: (m: { sessionId: string; cwd: string; repoKey: string }) => void;
    eventRemoved?: (eventId: string) => void;
  };
  let settings: UiSettings;
  let monitor: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    document.body.innerHTML = MONITOR_HTML;
    // jsdom does not implement scrollIntoView; shim it so the cross-highlight reveal
    // (§16.8) can call it.
    window.HTMLElement.prototype.scrollIntoView = () => {};
    handlers = {};
    settings = { ...DEFAULT_UI_SETTINGS };
    monitor = {
      onEvent: vi.fn((cb) => (handlers.event = cb)),
      onEventRemoved: vi.fn((cb) => (handlers.eventRemoved = cb)),
      onUpdate: vi.fn((cb) => (handlers.update = cb)),
      onExit: vi.fn((cb) => (handlers.exit = cb)),
      onCommandsChanged: vi.fn(),
      onCwdChanged: vi.fn((cb) => (handlers.cwdChanged = cb)),
      currentRepo: vi.fn(async () => null),
      replay: vi.fn(async () => []),
      commands: vi.fn(async () => []),
      captureCommandText: vi.fn(async () => null),
      captureLast: vi.fn(async () => []),
      inject: vi.fn(),
      getSettings: vi.fn(async () => settings),
      setSettings: vi.fn((patch) => Object.assign(settings, patch)),
      todoList: vi.fn(async () => []),
      todoAdd: vi.fn(async () => []),
      todoSetStatus: vi.fn(async () => []),
    };
    (window as unknown as { monitor: typeof monitor }).monitor = monitor;
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  const blocks = () => document.getElementById('monitor-blocks')!;
  const status = () => document.getElementById('monitor-status')!;
  const byId = (id: string) => document.getElementById(id)!;
  const cardButtons = (el: HTMLElement) => Array.from(el.querySelectorAll('button')).map((b) => b.textContent);

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

  // ---- capture cards: Add to todo, command-output inject (§16.2 / §24.1 mockup) ----

  it('a finding card offers Add to todo and no Insert (semantic captures are not injected)', async () => {
    wireMonitorPane();
    await flush();
    handlers.event!(makeEvent({ id: 'f', type: 'finding', parentId: null, text: 'a finding' }));
    const card = blocks().querySelector('[data-event-id="f"]') as HTMLElement;
    expect(cardButtons(card)).toContain('Add to todo');
    expect(cardButtons(card).some((t) => t?.includes('Insert'))).toBe(false);
  });

  it('Add to todo posts the capture and confirms in place, leaving the card', async () => {
    wireMonitorPane();
    await flush();
    handlers.cwdChanged!({ sessionId: 's1', cwd: '/repo/src', repoKey: '/repo' });
    monitor.todoAdd.mockResolvedValue([makeTodo({ id: 'n1', repoKey: '/repo', text: 'finding one' })]);
    handlers.event!(makeEvent({ id: 'f1', type: 'finding', parentId: null, text: 'finding one' }));
    const card = blocks().querySelector('[data-event-id="f1"]') as HTMLElement;
    const add = Array.from(card.querySelectorAll('button')).find((b) => b.textContent === 'Add to todo')!;
    add.click();
    await flush();
    expect(monitor.todoAdd).toHaveBeenCalledWith('/repo', 'finding one', { type: 'finding', eventId: 'f1' });
    // The card stays put; the action just confirms (Undo is deferred to §24.2.1).
    expect(blocks().querySelector('[data-event-id="f1"]')).toBeTruthy();
    expect(add.textContent).toContain('Added');
    expect(add.disabled).toBe(true);
  });

  it('Add to todo updates the Todo tab active count from the returned list', async () => {
    monitor.todoAdd.mockResolvedValueOnce([makeTodo({ id: 't1', status: 'active' })]);
    wireMonitorPane();
    await flush();
    handlers.cwdChanged!({ sessionId: 's1', cwd: '/repo', repoKey: '/repo' });
    handlers.event!(makeEvent({ id: 'c', type: 'capture', text: 'note' }));
    const card = blocks().querySelector('[data-event-id="c"]') as HTMLElement;
    Array.from(card.querySelectorAll('button')).find((b) => b.textContent === 'Add to todo')!.click();
    await flush();
    expect(byId('todo-count').textContent).toBe('1');
  });

  it('re-pulls todos and updates the count when an external todo change is signaled (§16.2)', async () => {
    wireMonitorPane();
    await flush();
    handlers.cwdChanged!({ sessionId: 's1', cwd: '/repo', repoKey: '/repo' });
    await flush();
    expect(byId('todo-count').textContent).toBe('0');
    monitor.todoList.mockResolvedValue([makeTodo({ id: 't1', status: 'active' }), makeTodo({ id: 't2', status: 'active' })]);
    window.dispatchEvent(new CustomEvent(TODOS_CHANGED_EVENT));
    await flush();
    expect(monitor.todoList).toHaveBeenCalledWith('/repo');
    expect(byId('todo-count').textContent).toBe('2');
  });

  it('a command-output card offers Insert at cursor (no submit) and moves focus to the terminal', async () => {
    wireMonitorPane();
    await flush();
    let focusFired = 0;
    window.addEventListener(FOCUS_TERMINAL_EVENT, () => focusFired++);
    handlers.event!(makeEvent({ type: 'command-output', source: 'shell-integration', text: 'hi' }));
    const card = blocks().querySelector('.finding') as HTMLElement;
    const insert = Array.from(card.querySelectorAll('button')).find((b) => b.textContent === 'Insert at cursor')!;
    insert.click();
    expect(monitor.inject).toHaveBeenCalledWith({ text: 'hi', submit: false });
    expect(focusFired).toBe(1);
  });

  // ---- rendering invariants ----

  it('never renders report blobs, tool-use, or diff cards (only carved findings, §15.x / §24.1)', async () => {
    wireMonitorPane();
    await flush();
    handlers.event!(makeEvent({ id: 'r', type: 'report', source: 'shadow-scan', text: 'whole report' }));
    handlers.event!(makeEvent({ id: 't', type: 'tool-use', text: 'Read(x)' }));
    handlers.event!(makeEvent({ id: 'd', type: 'diff', text: 'a/b' }));
    expect(blocks().querySelectorAll('.finding').length).toBe(0);
  });

  it('renders an unknown future type generically, never dropped', async () => {
    wireMonitorPane();
    await flush();
    handlers.event!(makeEvent({ id: 'u', type: 'mystery-type' as MonitorEvent['type'], text: 'x' }));
    const card = blocks().querySelector('.finding') as HTMLElement;
    expect(card).toBeTruthy();
    expect(card.querySelector('.m')!.textContent).toContain('mystery-type');
  });

  it('shows top-level cards newest-first (v2.6)', async () => {
    wireMonitorPane();
    await flush();
    handlers.event!(makeEvent({ id: 'a', text: 'first' }));
    handlers.event!(makeEvent({ id: 'b', text: 'second' }));
    const els = blocks().querySelectorAll('.finding');
    expect((els[0] as HTMLElement).dataset.eventId).toBe('b');
    expect((els[1] as HTMLElement).dataset.eventId).toBe('a');
  });

  it('renders a report’s findings as flat cards (the blob is carved, not shown — §15.x / §24.1)', async () => {
    wireMonitorPane();
    await flush();
    handlers.event!(makeEvent({ id: 'r', type: 'report', source: 'shadow-scan', text: 'partial report' }));
    handlers.event!(makeEvent({ id: 'f1', type: 'finding', parentId: 'r', text: 'one' }));
    expect(blocks().querySelector('[data-event-id="r"]')).toBeNull(); // the report blob is never a card
    expect(blocks().querySelector('[data-event-id="f1"]')).toBeTruthy();
  });

  it('removes a card when main signals the capture was superseded (§15.3)', async () => {
    wireMonitorPane();
    await flush();
    handlers.event!(makeEvent({ id: 'f1', type: 'finding', parentId: null, text: 'a finding' }));
    expect(blocks().querySelector('[data-event-id="f1"]')).toBeTruthy();
    handlers.eventRemoved!('f1');
    expect(blocks().querySelector('[data-event-id="f1"]')).toBeNull();
  });

  it('a retracted report cascades to its finding cards (§15.3 — flat cards tagged by parent)', async () => {
    wireMonitorPane();
    await flush();
    handlers.event!(makeEvent({ id: 'f1', type: 'finding', parentId: 'r', text: 'one' }));
    handlers.event!(makeEvent({ id: 'f2', type: 'finding', parentId: 'r', text: 'two' }));
    expect(blocks().querySelectorAll('.finding').length).toBe(2);
    handlers.eventRemoved!('r'); // supersede the report → its findings go with it
    expect(blocks().querySelectorAll('.finding').length).toBe(0);
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
    wireMonitorPane();
    await flush();
    handlers.event!(makeEvent({ text: '<script>alert(1)</script> & <img>' }));
    expect(blocks().querySelector('script')).toBeNull();
    expect(blocks().querySelector('.t')!.textContent).toBe('<script>alert(1)</script> & <img>');
  });

  // ---- cross-highlight between the terminal and the capture pane (§16.8) ----

  // Resize-safe (§16.8, merged from origin/main): this pane deals only in capture ids. The
  // terminal owns the coordinates — it marker-anchors each published span and resolves a
  // double-clicked row to an id (row→id matching is unit-tested in reveal.test.ts).
  describe('capture ↔ terminal cross-highlight (§16.8)', () => {
    const blockById = (id: string) => blocks().querySelector(`[data-event-id="${id}"]`) as HTMLElement;

    it('reveals the card named by app:reveal-capture {id}: scrolls to + highlights it', async () => {
      wireMonitorPane();
      await flush();
      handlers.event!(makeEvent({ id: 'c', type: 'capture', text: 'a capture', range: rangeRows(10, 14) }));
      const card = blockById('c');
      const scrollSpy = vi.spyOn(card, 'scrollIntoView');

      window.dispatchEvent(new CustomEvent(REVEAL_CAPTURE_EVENT, { detail: { id: 'c' } }));

      expect(card.classList.contains('revealed')).toBe(true);
      expect(scrollSpy).toHaveBeenCalled();
    });

    it('the reveal highlight clears itself after REVEAL_HIGHLIGHT_MS', async () => {
      vi.useFakeTimers();
      try {
        wireMonitorPane();
        await vi.advanceTimersByTimeAsync(0);
        handlers.event!(makeEvent({ id: 'c', type: 'capture', text: 'cap', range: rangeRows(0, 4) }));
        const card = blockById('c');
        window.dispatchEvent(new CustomEvent(REVEAL_CAPTURE_EVENT, { detail: { id: 'c' } }));
        expect(card.classList.contains('revealed')).toBe(true);
        await vi.advanceTimersByTimeAsync(REVEAL_HIGHLIGHT_MS);
        expect(card.classList.contains('revealed')).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('an app:reveal-capture for an id with no rendered card highlights nothing', async () => {
      wireMonitorPane();
      await flush();
      handlers.event!(makeEvent({ id: 'c', type: 'capture', text: 'cap', range: rangeRows(10, 14) }));
      window.dispatchEvent(new CustomEvent(REVEAL_CAPTURE_EVENT, { detail: { id: 'gone' } }));
      expect(blocks().querySelector('.revealed')).toBeNull();
    });

    it('publishes a ranged card as app:capture-range-add {id, range} so the terminal can anchor it', async () => {
      wireMonitorPane();
      await flush();
      let detail: { id: string; range: SelectionRange } | null = null;
      window.addEventListener(CAPTURE_RANGE_ADD_EVENT, (e) => (detail = (e as CustomEvent).detail), { once: true });

      handlers.event!(makeEvent({ id: 'f1', type: 'finding', parentId: null, text: 'one', range: rangeRows(3, 7) }));

      expect(detail).toMatchObject({ id: 'f1', range: { start: { y: 3 }, end: { y: 7 } } });
    });

    it('a manual capture with no range publishes no span', async () => {
      wireMonitorPane();
      await flush();
      let fired = false;
      window.addEventListener(CAPTURE_RANGE_ADD_EVENT, () => (fired = true), { once: true });
      handlers.event!(makeEvent({ id: 'c', type: 'capture', text: 'manual', range: null }));
      expect(fired).toBe(false);
    });

    it('retracting a card publishes app:capture-range-remove {id} (§15.3 marker cleanup)', async () => {
      wireMonitorPane();
      await flush();
      handlers.event!(makeEvent({ id: 'f1', type: 'finding', parentId: null, text: 'one', range: rangeRows(3, 7) }));
      let detail: { id: string } | null = null;
      window.addEventListener(CAPTURE_RANGE_REMOVE_EVENT, (e) => (detail = (e as CustomEvent).detail), { once: true });

      handlers.eventRemoved!('f1');

      expect(detail).toEqual({ id: 'f1' });
    });

    it('double-clicking a ranged card asks the terminal to reveal it by id', async () => {
      wireMonitorPane();
      await flush();
      handlers.event!(makeEvent({ id: 'c', type: 'capture', text: 'cap', range: rangeRows(3, 7) }));
      let detail: { id: string } | null = null;
      window.addEventListener(REVEAL_TERMINAL_EVENT, (e) => (detail = (e as CustomEvent).detail), { once: true });

      blockById('c').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

      expect(detail).toEqual({ id: 'c' });
    });

    it('double-clicking a card with no range (manual capture) asks for nothing', async () => {
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
