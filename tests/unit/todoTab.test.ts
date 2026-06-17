// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wireMonitorPane, FOCUS_TERMINAL_EVENT } from '../../src/renderer/src/monitor';
import { DEFAULT_UI_SETTINGS } from '../../src/shared/ipc';
import type { TodoItem, UiSettings } from '../../src/shared/ipc';

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
    <div id="monitor-blocks"></div>
  </section>
  <section id="panel-todo" role="tabpanel" hidden>
    <div id="todo-list"></div>
  </section>`;

function makeTodo(over: Partial<TodoItem>): TodoItem {
  return {
    id: 't1',
    repoKey: '/repoA',
    text: 'a todo',
    status: 'active',
    order: 1,
    createdAt: '2026-06-12T10:00:00.000Z',
    ...over,
  };
}

// §24.1 mockup-exact todo panel: a flat list of `.todo` rows, each a checkbox-circle
// (.chk, toggles done), a body (.tx text + .src provenance), and a Send action on
// active rows. Reorder / edit / manual-add / delete are deferred to §24.2.1.
describe('Todo tab (§24.1 mockup-exact — checkbox-done + Send)', () => {
  let handlers: { cwdChanged?: (m: { sessionId: string; cwd: string; repoKey: string }) => void };
  let settings: UiSettings;
  let monitor: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    document.body.innerHTML = MONITOR_HTML;
    handlers = {};
    settings = { ...DEFAULT_UI_SETTINGS };
    monitor = {
      onEvent: vi.fn(),
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

  const todoList = () => document.getElementById('todo-list')!;
  const rows = () => Array.from(todoList().querySelectorAll('.todo')) as HTMLElement[];
  const text = (el: HTMLElement) => el.querySelector('.tx')!.textContent;

  /** Load a repo's todos by firing the cwd-change the pane subscribes to. */
  async function loadRepo(repoKey: string, list: TodoItem[]): Promise<void> {
    monitor.todoList.mockResolvedValue(list);
    handlers.cwdChanged!({ sessionId: 's1', cwd: repoKey, repoKey });
    await flush();
  }

  it('renders todos in order, each with its text and a checkbox', async () => {
    wireMonitorPane();
    await flush();
    await loadRepo('/repoA', [makeTodo({ id: 'a', text: 'first', order: 1 }), makeTodo({ id: 'b', text: 'second', order: 2 })]);
    expect(rows().map(text)).toEqual(['first', 'second']);
    expect(rows()[0].querySelector('.chk')).toBeTruthy();
  });

  it('shows done todos inline and dimmed (a .done row), not in a separate section', async () => {
    wireMonitorPane();
    await flush();
    await loadRepo('/repoA', [makeTodo({ id: 'a', text: 'active one', order: 1 }), makeTodo({ id: 'd', text: 'done one', status: 'done', order: 2 })]);
    expect(rows().map(text)).toEqual(['active one', 'done one']);
    expect(rows()[1].classList.contains('done')).toBe(true);
    expect(todoList().querySelector('.todo-done')).toBeNull();
  });

  it('clicking the checkbox on an active todo marks it done', async () => {
    wireMonitorPane();
    await flush();
    await loadRepo('/repoA', [makeTodo({ id: 'a', text: 'task' })]);
    (rows()[0].querySelector('.chk') as HTMLElement).click();
    await flush();
    expect(monitor.todoSetStatus).toHaveBeenCalledWith('/repoA', 'a', 'done');
  });

  it('clicking the checkbox on a done todo re-activates it', async () => {
    wireMonitorPane();
    await flush();
    await loadRepo('/repoA', [makeTodo({ id: 'd', text: 'done task', status: 'done' })]);
    (rows()[0].querySelector('.chk') as HTMLElement).click();
    await flush();
    expect(monitor.todoSetStatus).toHaveBeenCalledWith('/repoA', 'd', 'active');
  });

  it('Send on an active todo injects with submit and keeps focus in the action window', async () => {
    wireMonitorPane();
    await flush();
    let focusFired = 0;
    window.addEventListener(FOCUS_TERMINAL_EVENT, () => focusFired++);
    await loadRepo('/repoA', [makeTodo({ id: 'a', text: 'task' })]);
    (rows()[0].querySelector('.todo-send') as HTMLButtonElement).click();
    await flush();
    expect(monitor.inject).toHaveBeenCalledWith({ text: 'task', submit: true });
    expect(focusFired).toBe(0);
  });

  it('a done todo has no Send action', async () => {
    wireMonitorPane();
    await flush();
    await loadRepo('/repoA', [makeTodo({ id: 'd', status: 'done' })]);
    expect(rows()[0].querySelector('.todo-send')).toBeNull();
  });

  it('renders provenance: a capture-sourced todo shows its origin, a manual one says manual', async () => {
    wireMonitorPane();
    await flush();
    await loadRepo('/repoA', [
      makeTodo({ id: 'a', text: 'from a finding', order: 1, source: { type: 'finding', eventId: 'e1' } }),
      makeTodo({ id: 'm', text: 'typed by hand', order: 2, source: { type: 'manual' } }),
    ]);
    expect(rows()[0].querySelector('.src')!.textContent).toContain('finding');
    expect(rows()[1].querySelector('.src')!.textContent!.toLowerCase()).toContain('manual');
  });

  it('the Todo tab count reflects the number of active todos', async () => {
    wireMonitorPane();
    await flush();
    await loadRepo('/repoA', [makeTodo({ id: 'a' }), makeTodo({ id: 'b' }), makeTodo({ id: 'd', status: 'done' })]);
    expect(document.getElementById('todo-count')!.textContent).toBe('2');
  });

  it('a repo change swaps the displayed list', async () => {
    wireMonitorPane();
    await flush();
    await loadRepo('/repoA', [makeTodo({ id: 'a', text: 'repo A todo' })]);
    expect(rows().map(text)).toEqual(['repo A todo']);
    await loadRepo('/repoB', [makeTodo({ id: 'z', repoKey: '/repoB', text: 'repo B todo' })]);
    expect(rows().map(text)).toEqual(['repo B todo']);
  });
});
