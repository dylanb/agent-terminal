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
    <div id="command-history"></div>
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

describe('Todo tab (§16.4 — active/Done, manual add, reorder, edit, lifecycle)', () => {
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
  const items = () => Array.from(todoList().querySelectorAll('.todo-item')) as HTMLElement[];
  const activeItems = () => items().filter((el) => !el.classList.contains('done'));
  const btn = (el: HTMLElement, cls: string) => el.querySelector(`.${cls}`) as HTMLButtonElement;

  /** Load a repo's todos by firing the cwd-change the pane subscribes to. */
  async function loadRepo(repoKey: string, list: TodoItem[]): Promise<void> {
    monitor.todoList.mockResolvedValue(list);
    handlers.cwdChanged!({ sessionId: 's1', cwd: repoKey, repoKey });
    await flush();
  }

  it('renders the active list in order', async () => {
    wireMonitorPane();
    await flush();
    await loadRepo('/repoA', [makeTodo({ id: 'a', text: 'first', order: 1 }), makeTodo({ id: 'b', text: 'second', order: 2 })]);
    expect(activeItems().map((el) => el.querySelector('.todo-text')!.textContent)).toEqual(['first', 'second']);
  });

  it('shows done todos in a separate Done section, filtered out of active', async () => {
    wireMonitorPane();
    await flush();
    await loadRepo('/repoA', [makeTodo({ id: 'a', text: 'active one' }), makeTodo({ id: 'd', text: 'done one', status: 'done', order: 0 })]);
    expect(activeItems().map((el) => el.querySelector('.todo-text')!.textContent)).toEqual(['active one']);
    const done = todoList().querySelector('.todo-done')!;
    expect(done.textContent).toContain('done one');
  });

  it('manual add posts the typed text with a manual source and clears the input', async () => {
    wireMonitorPane();
    await flush();
    await loadRepo('/repoA', []);
    const input = document.getElementById('todo-new') as HTMLTextAreaElement | HTMLInputElement;
    input.value = 'write the docs';
    (document.getElementById('todo-add-btn') as HTMLButtonElement).click();
    await flush();
    expect(monitor.todoAdd).toHaveBeenCalledWith('/repoA', 'write the docs', { type: 'manual' });
    expect(input.value).toBe('');
  });

  it('Insert on an active todo injects, marks it done, and moves focus to the terminal', async () => {
    monitor.todoSetStatus.mockResolvedValue([makeTodo({ id: 'a', text: 'task', status: 'done' })]);
    wireMonitorPane();
    await flush();
    let focusFired = 0;
    window.addEventListener(FOCUS_TERMINAL_EVENT, () => focusFired++);
    await loadRepo('/repoA', [makeTodo({ id: 'a', text: 'task' })]);
    btn(activeItems()[0], 'todo-insert').click();
    await flush();
    expect(monitor.inject).toHaveBeenCalledWith({ text: 'task', submit: false });
    expect(monitor.todoSetStatus).toHaveBeenCalledWith('/repoA', 'a', 'done');
    expect(focusFired).toBe(1);
    expect(activeItems().length).toBe(0);
  });

  it('Insert & submit on a todo marks it done but keeps focus in the action window', async () => {
    monitor.todoSetStatus.mockResolvedValue([makeTodo({ id: 'a', status: 'done' })]);
    wireMonitorPane();
    await flush();
    let focusFired = 0;
    window.addEventListener(FOCUS_TERMINAL_EVENT, () => focusFired++);
    await loadRepo('/repoA', [makeTodo({ id: 'a', text: 'task' })]);
    btn(activeItems()[0], 'todo-submit').click();
    await flush();
    expect(monitor.inject).toHaveBeenCalledWith({ text: 'task', submit: true });
    expect(focusFired).toBe(0);
  });

  it('re-copying a done todo moves it back to active', async () => {
    wireMonitorPane();
    await flush();
    await loadRepo('/repoA', [makeTodo({ id: 'd', text: 'done task', status: 'done' })]);
    const doneItem = items().find((el) => el.classList.contains('done'))!;
    btn(doneItem, 'todo-insert').click();
    await flush();
    expect(monitor.todoSetStatus).toHaveBeenCalledWith('/repoA', 'd', 'active');
  });

  it('edit-in-place opens a textarea and Save persists via todoUpdate', async () => {
    wireMonitorPane();
    await flush();
    await loadRepo('/repoA', [makeTodo({ id: 'a', text: 'old text' })]);
    btn(activeItems()[0], 'todo-edit').click();
    const textarea = activeItems()[0].querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    expect(textarea.value).toBe('old text');
    textarea.value = 'new text';
    btn(activeItems()[0], 'todo-save').click();
    await flush();
    expect(monitor.todoUpdate).toHaveBeenCalledWith('/repoA', 'a', 'new text');
  });

  it('the down button reorders an active todo and persists the new order', async () => {
    wireMonitorPane();
    await flush();
    await loadRepo('/repoA', [makeTodo({ id: 'a', order: 1 }), makeTodo({ id: 'b', order: 2 }), makeTodo({ id: 'c', order: 3 })]);
    btn(activeItems()[0], 'todo-down').click(); // move 'a' down past 'b'
    await flush();
    expect(monitor.todoReorder).toHaveBeenCalledWith('/repoA', ['b', 'a', 'c']);
  });

  it('deleting a todo calls todoDelete', async () => {
    wireMonitorPane();
    await flush();
    await loadRepo('/repoA', [makeTodo({ id: 'a' })]);
    btn(activeItems()[0], 'todo-delete').click();
    await flush();
    expect(monitor.todoDelete).toHaveBeenCalledWith('/repoA', 'a');
  });

  it('each active todo exposes a drag handle for reordering (§16.4 a11y dual path)', async () => {
    wireMonitorPane();
    await flush();
    await loadRepo('/repoA', [makeTodo({ id: 'a' })]);
    expect(activeItems()[0].querySelector('.drag-handle')).toBeTruthy();
  });

  // ---- mid-edit swap block (§16.3 / plan 5b) ----

  it('blocks a repo swap while an edit is open, then applies it once the edit resolves', async () => {
    wireMonitorPane();
    await flush();
    await loadRepo('/repoA', [makeTodo({ id: 'a', text: 'editing me' })]);
    btn(activeItems()[0], 'todo-edit').click();

    // A cd to /repoB arrives mid-edit — the list must NOT swap.
    monitor.todoList.mockClear();
    monitor.todoList.mockResolvedValue([makeTodo({ id: 'z', repoKey: '/repoB', text: 'repo B todo' })]);
    handlers.cwdChanged!({ sessionId: 's1', cwd: '/repoB', repoKey: '/repoB' });
    await flush();
    expect(monitor.todoList).not.toHaveBeenCalled(); // swap blocked
    expect(todoList().querySelector('.swap-blocked')).toBeTruthy();

    // Resolve the edit (Save) — the in-flight update targets /repoA, then the swap proceeds.
    const textarea = activeItems()[0].querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = 'saved';
    btn(activeItems()[0], 'todo-save').click();
    await flush();
    expect(monitor.todoUpdate).toHaveBeenCalledWith('/repoA', 'a', 'saved');
    expect(monitor.todoList).toHaveBeenCalledWith('/repoB');
    expect(todoList().querySelector('.swap-blocked')).toBeNull();
  });
});
