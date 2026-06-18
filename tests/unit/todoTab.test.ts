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
    <button id="capture-last">Capture last report</button>
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

/** A fully-stubbed window.monitor; tests override the methods they exercise. */
function baseMonitor(handlers: {
  cwdChanged?: (m: { sessionId: string; cwd: string; repoKey: string }) => void;
}): Record<string, ReturnType<typeof vi.fn>> {
  return {
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
    captureLast: vi.fn(async () => []),
    dismiss: vi.fn(),
    dismissAll: vi.fn(),
    clearCommands: vi.fn(),
    learnChrome: vi.fn(),
    inject: vi.fn(),
    getSettings: vi.fn(async () => ({ ...DEFAULT_UI_SETTINGS })),
    setSettings: vi.fn(),
    todoList: vi.fn(async () => []),
    todoAdd: vi.fn(async () => []),
    todoUpdate: vi.fn(async () => []),
    todoReorder: vi.fn(async () => []),
    todoSetStatus: vi.fn(async () => []),
    todoDelete: vi.fn(async () => []),
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
      captureLast: vi.fn(async () => []),
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

  it('Send on an active todo injects WITHOUT submit and moves focus to the terminal so the user can edit (§24.2.1)', async () => {
    wireMonitorPane();
    await flush();
    let focusFired = 0;
    window.addEventListener(FOCUS_TERMINAL_EVENT, () => focusFired++);
    await loadRepo('/repoA', [makeTodo({ id: 'a', text: 'task' })]);
    (rows()[0].querySelector('.todo-send') as HTMLButtonElement).click();
    await flush();
    expect(monitor.inject).toHaveBeenCalledWith({ text: 'task', submit: false });
    expect(focusFired).toBe(1);
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

// §24.2.1 Todo-panel restorations, re-skinned into the mockup row language: manual add,
// reorder (↑/↓ + drag), edit-in-place (better affordance — contenteditable, no box swap),
// and a two-step undoable delete. Main-process IPC for all of these already exists.
describe('Todo tab §24.2.1 — manual add', () => {
  let handlers: { cwdChanged?: (m: { sessionId: string; cwd: string; repoKey: string }) => void };
  let settings: UiSettings;
  let monitor: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    document.body.innerHTML = MONITOR_HTML;
    handlers = {};
    settings = { ...DEFAULT_UI_SETTINGS };
    monitor = baseMonitor(handlers);
    (window as unknown as { monitor: typeof monitor }).monitor = monitor;
    void settings;
  });
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  const todoList = () => document.getElementById('todo-list')!;

  async function loadRepo(repoKey: string, list: TodoItem[]): Promise<void> {
    monitor.todoList.mockResolvedValue(list);
    handlers.cwdChanged!({ sessionId: 's1', cwd: repoKey, repoKey });
    await flush();
  }

  it('typing a new todo and clicking Add posts it as a manual todo to the current repo', async () => {
    wireMonitorPane();
    await flush();
    await loadRepo('/repoA', []);
    const input = todoList().querySelector('#todo-new') as HTMLTextAreaElement;
    const addBtn = todoList().querySelector('#todo-add-btn') as HTMLButtonElement;
    expect(input).toBeTruthy();
    input.value = 'hand-written task';
    addBtn.click();
    await flush();
    expect(monitor.todoAdd).toHaveBeenCalledWith('/repoA', 'hand-written task', { type: 'manual' });
  });

  it('does not post an empty/whitespace todo', async () => {
    wireMonitorPane();
    await flush();
    await loadRepo('/repoA', []);
    const input = todoList().querySelector('#todo-new') as HTMLTextAreaElement;
    input.value = '   ';
    (todoList().querySelector('#todo-add-btn') as HTMLButtonElement).click();
    await flush();
    expect(monitor.todoAdd).not.toHaveBeenCalled();
  });
});

describe('Todo tab §24.2.1 — reorder', () => {
  let handlers: { cwdChanged?: (m: { sessionId: string; cwd: string; repoKey: string }) => void };
  let monitor: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    document.body.innerHTML = MONITOR_HTML;
    handlers = {};
    monitor = baseMonitor(handlers);
    (window as unknown as { monitor: typeof monitor }).monitor = monitor;
  });
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  const rows = () => Array.from(document.getElementById('todo-list')!.querySelectorAll('.todo')) as HTMLElement[];
  async function loadRepo(repoKey: string, list: TodoItem[]): Promise<void> {
    monitor.todoList.mockResolvedValue(list);
    handlers.cwdChanged!({ sessionId: 's1', cwd: repoKey, repoKey });
    await flush();
  }

  it('clicking ↓ on the first todo persists the swapped order via todoReorder', async () => {
    wireMonitorPane();
    await flush();
    await loadRepo('/repoA', [makeTodo({ id: 'a', order: 1 }), makeTodo({ id: 'b', order: 2 })]);
    (rows()[0].querySelector('.todo-down') as HTMLButtonElement).click();
    await flush();
    expect(monitor.todoReorder).toHaveBeenCalledWith('/repoA', ['b', 'a']);
  });

  it('↑ is disabled on the first todo and ↓ on the last', async () => {
    wireMonitorPane();
    await flush();
    await loadRepo('/repoA', [makeTodo({ id: 'a', order: 1 }), makeTodo({ id: 'b', order: 2 })]);
    expect((rows()[0].querySelector('.todo-up') as HTMLButtonElement).disabled).toBe(true);
    expect((rows()[1].querySelector('.todo-down') as HTMLButtonElement).disabled).toBe(true);
  });

  it('done todos do not carry reorder controls', async () => {
    wireMonitorPane();
    await flush();
    await loadRepo('/repoA', [makeTodo({ id: 'd', status: 'done' })]);
    expect(rows()[0].querySelector('.todo-up')).toBeNull();
  });
});

describe('Todo tab §24.2.1 — edit-in-place', () => {
  let handlers: { cwdChanged?: (m: { sessionId: string; cwd: string; repoKey: string }) => void };
  let monitor: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    document.body.innerHTML = MONITOR_HTML;
    handlers = {};
    monitor = baseMonitor(handlers);
    (window as unknown as { monitor: typeof monitor }).monitor = monitor;
  });
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  const rows = () => Array.from(document.getElementById('todo-list')!.querySelectorAll('.todo')) as HTMLElement[];
  async function loadRepo(repoKey: string, list: TodoItem[]): Promise<void> {
    monitor.todoList.mockResolvedValue(list);
    handlers.cwdChanged!({ sessionId: 's1', cwd: repoKey, repoKey });
    await flush();
  }

  it('Edit makes the text editable in place (no textarea box swap) and Save persists via todoUpdate', async () => {
    wireMonitorPane();
    await flush();
    await loadRepo('/repoA', [makeTodo({ id: 'a', text: 'old text' })]);
    (rows()[0].querySelector('.todo-edit') as HTMLButtonElement).click();
    const tx = rows()[0].querySelector('.tx') as HTMLElement;
    expect(tx.contentEditable).toBe('true');
    expect(rows()[0].querySelector('textarea')).toBeNull();
    tx.textContent = 'new text';
    (rows()[0].querySelector('.todo-save') as HTMLButtonElement).click();
    await flush();
    expect(monitor.todoUpdate).toHaveBeenCalledWith('/repoA', 'a', 'new text');
  });

  it('Cancel discards the edit without calling todoUpdate', async () => {
    wireMonitorPane();
    await flush();
    await loadRepo('/repoA', [makeTodo({ id: 'a', text: 'keep me' })]);
    (rows()[0].querySelector('.todo-edit') as HTMLButtonElement).click();
    (rows()[0].querySelector('.tx') as HTMLElement).textContent = 'unsaved';
    (rows()[0].querySelector('.todo-cancel') as HTMLButtonElement).click();
    await flush();
    expect(monitor.todoUpdate).not.toHaveBeenCalled();
    expect((rows()[0].querySelector('.tx') as HTMLElement).textContent).toBe('keep me');
  });

  it('a repo change while editing is deferred and surfaces a notice until the edit resolves', async () => {
    wireMonitorPane();
    await flush();
    await loadRepo('/repoA', [makeTodo({ id: 'a', text: 'editing this' })]);
    (rows()[0].querySelector('.todo-edit') as HTMLButtonElement).click();
    monitor.todoList.mockResolvedValue([makeTodo({ id: 'z', repoKey: '/repoB', text: 'repo B todo' })]);
    handlers.cwdChanged!({ sessionId: 's1', cwd: '/repoB', repoKey: '/repoB' });
    await flush();
    expect(document.getElementById('todo-list')!.querySelector('.swap-blocked')).toBeTruthy();
    expect(rows().some((r) => r.querySelector('.tx')!.textContent === 'editing this')).toBe(true);
    (rows().find((r) => r.querySelector('.todo-cancel'))!.querySelector('.todo-cancel') as HTMLButtonElement).click();
    await flush();
    expect(rows().map((r) => r.querySelector('.tx')!.textContent)).toEqual(['repo B todo']);
  });
});

describe('Todo tab §24.2.1 — two-step undoable delete', () => {
  let handlers: { cwdChanged?: (m: { sessionId: string; cwd: string; repoKey: string }) => void };
  let monitor: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = MONITOR_HTML;
    handlers = {};
    monitor = baseMonitor(handlers);
    (window as unknown as { monitor: typeof monitor }).monitor = monitor;
  });
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const rows = () => Array.from(document.getElementById('todo-list')!.querySelectorAll('.todo')) as HTMLElement[];
  async function loadRepo(repoKey: string, list: TodoItem[]): Promise<void> {
    monitor.todoList.mockResolvedValue(list);
    handlers.cwdChanged!({ sessionId: 's1', cwd: repoKey, repoKey });
    await vi.advanceTimersByTimeAsync(0);
  }

  it('× asks to confirm; confirming defers the delete behind an Undo and only fires todoDelete after TODO_UNDO_MS', async () => {
    wireMonitorPane();
    await vi.advanceTimersByTimeAsync(0);
    await loadRepo('/repoA', [makeTodo({ id: 'a', text: 'delete me' })]);

    (rows()[0].querySelector('.todo-delete') as HTMLButtonElement).click();
    expect(rows()[0].querySelector('.todo-delete-confirm')).toBeTruthy();
    (rows()[0].querySelector('.todo-delete-confirm') as HTMLButtonElement).click();

    expect(rows()[0].querySelector('.todo-undo')).toBeTruthy();
    expect(monitor.todoDelete).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(monitor.todoDelete).toHaveBeenCalledWith('/repoA', 'a');
  });

  it('Undo cancels the pending delete with no server round-trip', async () => {
    wireMonitorPane();
    await vi.advanceTimersByTimeAsync(0);
    await loadRepo('/repoA', [makeTodo({ id: 'a', text: 'spare me' })]);

    (rows()[0].querySelector('.todo-delete') as HTMLButtonElement).click();
    (rows()[0].querySelector('.todo-delete-confirm') as HTMLButtonElement).click();
    (rows()[0].querySelector('.todo-undo') as HTMLButtonElement).click();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(monitor.todoDelete).not.toHaveBeenCalled();
    expect(rows()[0].querySelector('.tx')!.textContent).toBe('spare me');
  });
});

// §24.2.1 review fixes: reorder must not disturb inline done rows; focus must follow the
// edit/delete/confirm transitions (WCAG 2.4.3); the contenteditable field must be labelled;
// the drag wiring must be exercised.
describe('Todo tab §24.2.1 — review fixes (reorder stability, focus, a11y label, drag)', () => {
  let handlers: { cwdChanged?: (m: { sessionId: string; cwd: string; repoKey: string }) => void };
  let monitor: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    document.body.innerHTML = MONITOR_HTML;
    handlers = {};
    monitor = baseMonitor(handlers);
    (window as unknown as { monitor: typeof monitor }).monitor = monitor;
  });
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  const todoList = () => document.getElementById('todo-list')!;
  const rows = () => Array.from(todoList().querySelectorAll('.todo')) as HTMLElement[];
  async function loadRepo(repoKey: string, list: TodoItem[]): Promise<void> {
    monitor.todoList.mockResolvedValue(list);
    handlers.cwdChanged!({ sessionId: 's1', cwd: repoKey, repoKey });
    await flush();
  }

  it('reordering an active todo past an inline done row leaves the done row in place', async () => {
    wireMonitorPane();
    await flush();
    await loadRepo('/repoA', [
      makeTodo({ id: 'a', text: 'A', order: 1 }),
      makeTodo({ id: 'd', text: 'D', status: 'done', order: 2 }),
      makeTodo({ id: 'c', text: 'C', order: 3 }),
    ]);
    // ↓ on the first active (A): it swaps with the next ACTIVE (C), skipping done D — and D
    // must keep its slot in the persisted order, not get shoved to an end.
    (rows()[0].querySelector('.todo-down') as HTMLButtonElement).click();
    await flush();
    expect(monitor.todoReorder).toHaveBeenCalledWith('/repoA', ['c', 'd', 'a']);
  });

  it('Edit moves focus into the editable text; the field is a labelled textbox', async () => {
    wireMonitorPane();
    await flush();
    await loadRepo('/repoA', [makeTodo({ id: 'a', text: 'edit me' })]);
    (rows()[0].querySelector('.todo-edit') as HTMLButtonElement).click();
    const tx = rows()[0].querySelector('.tx') as HTMLElement;
    expect(document.activeElement).toBe(tx);
    expect(tx.getAttribute('role')).toBe('textbox');
    expect(tx.getAttribute('aria-label')).toBeTruthy();
  });

  it('Delete moves focus to Confirm; confirming moves focus to Undo', async () => {
    wireMonitorPane();
    await flush();
    await loadRepo('/repoA', [makeTodo({ id: 'a', text: 'del' })]);
    (rows()[0].querySelector('.todo-delete') as HTMLButtonElement).click();
    expect(document.activeElement).toBe(rows()[0].querySelector('.todo-delete-confirm'));
    (rows()[0].querySelector('.todo-delete-confirm') as HTMLButtonElement).click();
    expect(document.activeElement).toBe(rows()[0].querySelector('.todo-undo'));
  });

  it('dragging one todo onto another reorders via todoReorder (drag wiring)', async () => {
    wireMonitorPane();
    await flush();
    await loadRepo('/repoA', [makeTodo({ id: 'a', order: 1 }), makeTodo({ id: 'b', order: 2 })]);
    rows()[0].dispatchEvent(new Event('dragstart', { bubbles: true }));
    rows()[1].dispatchEvent(new Event('dragover', { bubbles: true }));
    rows()[1].dispatchEvent(new Event('drop', { bubbles: true }));
    await flush();
    expect(monitor.todoReorder).toHaveBeenCalledWith('/repoA', ['b', 'a']);
  });
});
