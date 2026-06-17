// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wireMonitorPane, REVEAL_TERMINAL_EVENT } from '../../src/renderer/src/monitor';
import { DEFAULT_UI_SETTINGS } from '../../src/shared/ipc';
import type { MonitorEvent, TodoItem, UiSettings } from '../../src/shared/ipc';

const flush = () => new Promise((r) => setTimeout(r, 0));

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
    <div class="head"><button id="capture-last">Capture last report</button></div>
    <div id="monitor-blocks"></div>
  </section>
  <section id="panel-todo" role="tabpanel" hidden>
    <div id="todo-list"></div>
  </section>`;

function makeEvent(over: Partial<MonitorEvent>): MonitorEvent {
  return {
    id: 'e1',
    sessionId: 's1',
    type: 'report',
    text: 'a captured report worth keeping',
    capturedAt: Date.parse('2026-06-12T10:00:00.000Z'),
    truncated: false,
    ...over,
  } as MonitorEvent;
}

describe('Capture tab "Add to todo" button (§16.2 — capture block → todo)', () => {
  let handlers: {
    event?: (e: MonitorEvent) => void;
    cwdChanged?: (m: { sessionId: string; cwd: string; repoKey: string }) => void;
  };
  let settings: UiSettings;
  let monitor: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    document.body.innerHTML = MONITOR_HTML;
    handlers = {};
    settings = { ...DEFAULT_UI_SETTINGS };
    monitor = {
      onEvent: vi.fn((cb) => (handlers.event = cb)),
      onEventRemoved: vi.fn(),
      onUpdate: vi.fn(),
      onExit: vi.fn(),
      onCommandsChanged: vi.fn(),
      onCwdChanged: vi.fn((cb) => (handlers.cwdChanged = cb)),
      currentRepo: vi.fn(async () => null),
      replay: vi.fn(async () => []),
      commands: vi.fn(async () => []),
      captureCommandText: vi.fn(async () => null),
      captureLast: vi.fn(async () => []),
      dismiss: vi.fn(),
      dismissAll: vi.fn(),
      clearCommands: vi.fn(),
      learnChrome: vi.fn(),
      inject: vi.fn(),
      getSettings: vi.fn(async () => settings),
      setSettings: vi.fn(),
      todoList: vi.fn(async () => []),
      todoAdd: vi.fn(async (repoKey: string, text: string): Promise<TodoItem[]> => [
        { id: 'new', repoKey, text, status: 'active', order: 1, createdAt: '2026-06-12T10:00:00.000Z' },
      ]),
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

  it('clicking Add to todo on a captured finding posts it to the current repo', async () => {
    wireMonitorPane();
    await flush();
    handlers.cwdChanged!({ sessionId: 's1', cwd: '/repoA', repoKey: '/repoA' });
    await flush();

    handlers.event!(makeEvent({ id: 'e1', type: 'finding', parentId: null, text: 'remember this finding' }));
    const add = blocks().querySelector('.add-to-todo') as HTMLButtonElement;
    expect(add).toBeTruthy();
    add.click();
    await flush();

    expect(monitor.todoAdd).toHaveBeenCalledWith('/repoA', 'remember this finding', {
      type: 'finding',
      eventId: 'e1',
    });
  });

  it('works when the repo key was set before mount (initial cwd missed the live broadcast)', async () => {
    // Real startup: the shell's first OSC 7 broadcasts the repo key before the pane
    // subscribes, so it is delivered only via the mount-time query, not onCwdChanged.
    monitor.currentRepo.mockResolvedValue({ cwd: '/repoA', repoKey: '/repoA' });
    wireMonitorPane();
    await flush(); // mount-time currentRepo() resolves; NO cwdChanged is ever fired

    handlers.event!(makeEvent({ id: 'e2', type: 'finding', parentId: null, text: 'keep this one too' }));
    (blocks().querySelector('.add-to-todo') as HTMLButtonElement).click();
    await flush();

    expect(monitor.todoAdd).toHaveBeenCalledWith('/repoA', 'keep this one too', {
      type: 'finding',
      eventId: 'e2',
    });
  });
});

// §21.1 / v2.27: capture is manual + single-slot — clicking "Capture last report" runs
// detection on demand (capture:last) and the pane shows the one returned report's findings,
// replacing whatever it showed before. Nothing auto-emits.
describe('Capture last report button (§21.1 — manual single-slot)', () => {
  let settings: UiSettings;
  let monitor: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    document.body.innerHTML = MONITOR_HTML;
    settings = { ...DEFAULT_UI_SETTINGS };
    monitor = {
      onEvent: vi.fn(),
      onEventRemoved: vi.fn(),
      onUpdate: vi.fn(),
      onExit: vi.fn(),
      onCommandsChanged: vi.fn(),
      onCwdChanged: vi.fn(),
      currentRepo: vi.fn(async () => null),
      replay: vi.fn(async () => []),
      commands: vi.fn(async () => []),
      captureCommandText: vi.fn(async () => null),
      captureLast: vi.fn(async () => []),
      dismiss: vi.fn(),
      dismissAll: vi.fn(),
      clearCommands: vi.fn(),
      learnChrome: vi.fn(),
      inject: vi.fn(),
      getSettings: vi.fn(async () => settings),
      setSettings: vi.fn(),
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

  const button = () => document.getElementById('capture-last') as HTMLButtonElement;
  const findings = () => Array.from(document.getElementById('monitor-blocks')!.querySelectorAll('.finding')) as HTMLElement[];
  const text = (el: HTMLElement) => el.querySelector('.t')!.textContent;

  function report(id: string, t: string): MonitorEvent {
    return makeEvent({ id, type: 'finding', parentId: 'r1', text: t, range: { start: { x: 0, y: 0 }, end: { x: 80, y: 0 }, baseY: 0, bufferType: 'normal' } });
  }

  it('clicking the button runs capture:last and renders the returned findings', async () => {
    monitor.captureLast.mockResolvedValue([report('f1', 'first finding'), report('f2', 'second finding')]);
    wireMonitorPane();
    await flush();

    button().click();
    await flush();

    expect(monitor.captureLast).toHaveBeenCalledTimes(1);
    expect(findings().map(text)).toEqual(['first finding', 'second finding']);
  });

  it('a second capture replaces the prior findings (single-slot)', async () => {
    monitor.captureLast.mockResolvedValueOnce([report('f1', 'old finding')]);
    wireMonitorPane();
    await flush();
    button().click();
    await flush();
    expect(findings().map(text)).toEqual(['old finding']);

    monitor.captureLast.mockResolvedValueOnce([report('f9', 'fresh finding')]);
    button().click();
    await flush();
    expect(findings().map(text)).toEqual(['fresh finding']);
  });

  it('double-clicking a captured finding asks the terminal to reveal its rows (§16.8)', async () => {
    monitor.captureLast.mockResolvedValue([report('f1', 'ranged finding')]);
    wireMonitorPane();
    await flush();
    button().click();
    await flush();

    let revealedId: string | undefined;
    window.addEventListener(REVEAL_TERMINAL_EVENT, (e) => {
      revealedId = (e as CustomEvent<{ id: string }>).detail.id;
    });
    findings()[0].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(revealedId).toBe('f1');
  });
});
