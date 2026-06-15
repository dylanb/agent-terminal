// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wireMonitorPane } from '../../src/renderer/src/monitor';
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

  it('clicking Add to todo on a captured report posts it to the current repo', async () => {
    wireMonitorPane();
    await flush();
    handlers.cwdChanged!({ sessionId: 's1', cwd: '/repoA', repoKey: '/repoA' });
    await flush();

    handlers.event!(makeEvent({ id: 'e1', type: 'report', text: 'remember this finding' }));
    const add = blocks().querySelector('.add-to-todo') as HTMLButtonElement;
    expect(add).toBeTruthy();
    add.click();
    await flush();

    expect(monitor.todoAdd).toHaveBeenCalledWith('/repoA', 'remember this finding', {
      type: 'report',
      eventId: 'e1',
    });
  });

  it('works when the repo key was set before mount (initial cwd missed the live broadcast)', async () => {
    // Real startup: the shell's first OSC 7 broadcasts the repo key before the pane
    // subscribes, so it is delivered only via the mount-time query, not onCwdChanged.
    monitor.currentRepo.mockResolvedValue({ cwd: '/repoA', repoKey: '/repoA' });
    wireMonitorPane();
    await flush(); // mount-time currentRepo() resolves; NO cwdChanged is ever fired

    handlers.event!(makeEvent({ id: 'e2', type: 'report', text: 'keep this one too' }));
    (blocks().querySelector('.add-to-todo') as HTMLButtonElement).click();
    await flush();

    expect(monitor.todoAdd).toHaveBeenCalledWith('/repoA', 'keep this one too', {
      type: 'report',
      eventId: 'e2',
    });
  });
});
