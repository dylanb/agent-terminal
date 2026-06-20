// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wireMonitorPane } from '../../src/renderer/src/monitor';
import { createTodoTab } from '../../src/renderer/src/todoTab';
import { FOCUS_TERMINAL_EVENT, FLOW_CHANGED_EVENT } from '../../src/renderer/src/paneActions';
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
    listTemplates: vi.fn(async () => ({ templates: [] })),
    instantiateTemplate: vi.fn(async () => []),
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
      listTemplates: vi.fn(async () => ({ templates: [] })),
      instantiateTemplate: vi.fn(async () => []),
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

  it('a rejected refresh (main restart) renders empty and surfaces no unhandled rejection (§16.4)', async () => {
    wireMonitorPane();
    await flush();
    monitor.todoList.mockRejectedValueOnce(new Error('ipc down'));
    monitor.listTemplates.mockRejectedValueOnce(new Error('ipc down'));
    handlers.cwdChanged!({ sessionId: 's1', cwd: '/repoA', repoKey: '/repoA' });
    await flush();
    // refresh()'s todoList/listTemplates rejections must be swallowed — vitest fails the run on an
    // unhandled rejection (the §16.4 invariant every other IPC call in this file already keeps).
    expect(rows()).toHaveLength(0);
  });

  it('renders todos in order, each with its text and a checkbox', async () => {
    wireMonitorPane();
    await flush();
    await loadRepo('/repoA', [makeTodo({ id: 'a', text: 'first', order: 1 }), makeTodo({ id: 'b', text: 'second', order: 2 })]);
    expect(rows().map(text)).toEqual(['first', 'second']);
    expect(rows()[0].querySelector('.chk')).toBeTruthy();
  });

  it('ignores a stale todoList response after the repo changed mid-flight (race)', async () => {
    wireMonitorPane();
    await flush();
    const deferred = new Map<string, () => void>();
    monitor.todoList.mockImplementation(
      (repoKey: string) =>
        new Promise((res) => {
          deferred.set(repoKey, () => res([makeTodo({ id: repoKey, text: `todo for ${repoKey}`, repoKey })]));
        }),
    );
    handlers.cwdChanged!({ sessionId: 's1', cwd: '/repoA', repoKey: '/repoA' }); // todoList('/repoA') pending
    handlers.cwdChanged!({ sessionId: 's1', cwd: '/repoB', repoKey: '/repoB' }); // current repo now /repoB
    deferred.get('/repoB')!(); // current repo resolves and renders
    await flush();
    deferred.get('/repoA')!(); // the STALE /repoA resolves last
    await flush();
    await flush();
    expect(rows().map(text)).toEqual(['todo for /repoB']); // not overwritten by the stale /repoA list
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

  it('a done todo keeps its action buttons but disabled, so the row layout stays constant', async () => {
    wireMonitorPane();
    await flush();
    await loadRepo('/repoA', [makeTodo({ id: 'd', status: 'done' })]);
    const row = rows()[0];
    expect(row.querySelector('.todo-send')).not.toBeNull();
    for (const sel of ['.todo-send', '.todo-edit', '.todo-up', '.todo-down']) {
      expect((row.querySelector(sel) as HTMLButtonElement).disabled).toBe(true);
    }
    // Delete stays usable — you can still remove a completed todo.
    expect((row.querySelector('.todo-delete') as HTMLButtonElement).disabled).toBe(false);
  });

  it('confirming a delete keeps the action cluster in place and stacks the confirm below (no width jump)', async () => {
    wireMonitorPane();
    await flush();
    await loadRepo('/repoA', [makeTodo({ id: 'a', status: 'active' })]);
    (rows()[0].querySelector('.todo-delete') as HTMLButtonElement).click();
    const row = rows()[0];
    expect(row.querySelector('.todo-delete-confirm')).not.toBeNull(); // confirm shown
    expect(row.querySelector('.todo-send')).not.toBeNull(); // cluster NOT replaced
    expect(row.querySelector('.todo-delete-bar')).not.toBeNull(); // in a separate stacked row
  });

  // Tri-state status (§16.3): active → (Send) → in_progress → (check) → done → (check) → active.
  // The checkbox renders the three ARIA states (false / mixed / true); the box itself only ever
  // marks not-done→done or done→active, and Send is the sole entry into in_progress.
  describe('tri-state status', () => {
    it('Send marks an active todo in-progress (checkbox goes mixed) and still injects without submit', async () => {
      wireMonitorPane();
      await flush();
      await loadRepo('/repoA', [makeTodo({ id: 'a', text: 'task' })]);
      monitor.todoSetStatus.mockResolvedValue([makeTodo({ id: 'a', text: 'task', status: 'in_progress' })]);
      (rows()[0].querySelector('.todo-send') as HTMLButtonElement).click();
      await flush();
      expect(monitor.inject).toHaveBeenCalledWith({ text: 'task', submit: false });
      expect(monitor.todoSetStatus).toHaveBeenCalledWith('/repoA', 'a', 'in_progress');
      expect(rows()[0].querySelector('.chk')!.getAttribute('aria-checked')).toBe('mixed');
    });

    it('renders an in-progress todo with a mixed checkbox', async () => {
      wireMonitorPane();
      await flush();
      await loadRepo('/repoA', [makeTodo({ id: 'a', status: 'in_progress' })]);
      expect(rows()[0].querySelector('.chk')!.getAttribute('aria-checked')).toBe('mixed');
    });

    it('keeps the Send/edit/reorder actions on an in-progress todo (it is still outstanding)', async () => {
      wireMonitorPane();
      await flush();
      await loadRepo('/repoA', [makeTodo({ id: 'a', status: 'in_progress' })]);
      expect(rows()[0].querySelector('.todo-send')).not.toBeNull();
      expect(rows()[0].querySelector('.todo-edit')).not.toBeNull();
    });

    it('clicking the checkbox on an in-progress todo marks it done', async () => {
      wireMonitorPane();
      await flush();
      await loadRepo('/repoA', [makeTodo({ id: 'a', status: 'in_progress' })]);
      (rows()[0].querySelector('.chk') as HTMLElement).click();
      await flush();
      expect(monitor.todoSetStatus).toHaveBeenCalledWith('/repoA', 'a', 'done');
    });

    it('counts in-progress todos as outstanding', async () => {
      wireMonitorPane();
      await flush();
      await loadRepo('/repoA', [
        makeTodo({ id: 'a', status: 'in_progress', order: 1 }),
        makeTodo({ id: 'b', status: 'active', order: 2 }),
        makeTodo({ id: 'd', status: 'done', order: 3 }),
      ]);
      expect(document.getElementById('todo-count')!.textContent).toBe('2');
    });
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

  it('shows the manual-add row on mount, before any repo key is known', async () => {
    // currentRepo() resolves null and no cwd:changed has fired yet (e.g. before the first
    // OSC 7) — the add affordance must still be present, not a blank panel.
    wireMonitorPane();
    await flush();
    expect(document.getElementById('todo-new')).toBeTruthy();
    expect(document.getElementById('todo-add-btn')).toBeTruthy();
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

  it('done todos render reorder controls disabled (present but inert — constant layout)', async () => {
    wireMonitorPane();
    await flush();
    await loadRepo('/repoA', [makeTodo({ id: 'd', status: 'done' })]);
    const up = rows()[0].querySelector('.todo-up') as HTMLButtonElement;
    expect(up).not.toBeNull();
    expect(up.disabled).toBe(true);
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

  it('Saving an empty/whitespace edit does not persist and keeps the row in edit mode', async () => {
    wireMonitorPane();
    await flush();
    await loadRepo('/repoA', [makeTodo({ id: 'a', text: 'old text' })]);
    (rows()[0].querySelector('.todo-edit') as HTMLButtonElement).click();
    (rows()[0].querySelector('.tx') as HTMLElement).textContent = '   ';
    (rows()[0].querySelector('.todo-save') as HTMLButtonElement).click();
    await flush();
    expect(monitor.todoUpdate).not.toHaveBeenCalled();
    expect((rows()[0].querySelector('.tx') as HTMLElement).contentEditable).toBe('true');
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

  it('Escape cancels the edit and moves focus to the edit button (not <body>)', async () => {
    wireMonitorPane();
    await flush();
    await loadRepo('/repoA', [makeTodo({ id: 'a', text: 'edit me' })]);
    (rows()[0].querySelector('.todo-edit') as HTMLButtonElement).click();
    const tx = rows()[0].querySelector('.tx') as HTMLElement;
    tx.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await flush();
    expect(rows()[0].querySelector('.tx')!.getAttribute('contenteditable')).not.toBe('true'); // edit closed
    expect(document.activeElement).toBe(rows()[0].querySelector('.todo-edit'));
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

  // ---- On-demand todo-template picker in the overlay (§4.1/§6) ----
  // The control relocated here from the flow strip: a collapsed "From template" disclosure that
  // reveals a named-template picker, so the resting composer is just the manual-add field.
  describe('template picker (§4.1)', () => {
    const toggle = () => todoList().querySelector<HTMLButtonElement>('.tmpl-toggle');
    const pick = () => todoList().querySelector<HTMLSelectElement>('.tmpl-pick');
    const addBtn = () => todoList().querySelector<HTMLButtonElement>('.tmpl-add');
    const txt = (el: HTMLElement) => el.querySelector('.tx')!.textContent;

    async function loadRepoWithTemplates(
      repoKey: string,
      list: TodoItem[],
      lib: { templates: { ref: string; name: string }[]; defaultRef?: string },
    ): Promise<void> {
      monitor.listTemplates.mockResolvedValue(lib);
      await loadRepo(repoKey, list);
    }

    it('shows no template disclosure when the library is empty (gated to an active step)', async () => {
      wireMonitorPane();
      await flush();
      await loadRepoWithTemplates('/repoA', [], { templates: [] });
      expect(toggle()).toBeNull();
    });

    it('offers a collapsed "From template" disclosure when templates exist; the picker is hidden until opened', async () => {
      wireMonitorPane();
      await flush();
      await loadRepoWithTemplates('/repoA', [], {
        templates: [{ ref: 'ticket-grooming', name: 'Ticket grooming' }],
        defaultRef: 'ticket-grooming',
      });
      expect(toggle()).not.toBeNull();
      expect(toggle()!.getAttribute('aria-expanded')).toBe('false');
      expect(pick()).toBeNull(); // collapsed → no picker on screen (anti-clutter)
    });

    it('sets aria-controls only while the picker is open (no dangling idref when collapsed)', async () => {
      wireMonitorPane();
      await flush();
      await loadRepoWithTemplates('/repoA', [], { templates: [{ ref: 'pr-review', name: 'PR review' }] });
      expect(toggle()!.hasAttribute('aria-controls')).toBe(false); // collapsed → no idref to a non-existent group
      toggle()!.click();
      await flush();
      const ctrl = toggle()!.getAttribute('aria-controls');
      expect(ctrl).toBeTruthy();
      expect(document.getElementById(ctrl!)).not.toBeNull(); // points at the now-rendered group
    });

    it('opening the disclosure reveals the named picker, defaulting to the bound template', async () => {
      wireMonitorPane();
      await flush();
      await loadRepoWithTemplates('/repoA', [], {
        templates: [
          { ref: 'pr-review', name: 'PR review checklist' },
          { ref: 'ticket-grooming', name: 'Ticket grooming' },
        ],
        defaultRef: 'ticket-grooming',
      });
      toggle()!.click();
      await flush();
      expect(toggle()!.getAttribute('aria-expanded')).toBe('true');
      expect([...pick()!.options].map((o) => o.textContent)).toEqual(['PR review checklist', 'Ticket grooming']);
      expect(pick()!.value).toBe('ticket-grooming'); // the step's bound default
    });

    it('Add todos instantiates the chosen template and keeps the picker open', async () => {
      wireMonitorPane();
      await flush();
      await loadRepoWithTemplates('/repoA', [], {
        templates: [
          { ref: 'pr-review', name: 'PR review checklist' },
          { ref: 'ticket-grooming', name: 'Ticket grooming' },
        ],
        defaultRef: 'ticket-grooming',
      });
      monitor.instantiateTemplate.mockResolvedValue([makeTodo({ id: 'x', text: 'Check the diff' })]);
      toggle()!.click();
      await flush();
      pick()!.value = 'pr-review';
      addBtn()!.click();
      await flush();
      expect(monitor.instantiateTemplate).toHaveBeenCalledWith('/repoA', 'pr-review');
      expect(rows().map(txt)).toContain('Check the diff'); // the list updated from the result
      expect(pick()).not.toBeNull(); // stays open for another add (operator decision)
    });

    it('a rejected Add todos re-enables the button and does not surface an unhandled rejection (§16.4)', async () => {
      wireMonitorPane();
      await flush();
      await loadRepoWithTemplates('/repoA', [], {
        templates: [{ ref: 'pr-review', name: 'PR review checklist' }],
      });
      toggle()!.click();
      await flush();
      monitor.instantiateTemplate.mockRejectedValueOnce(new Error('ipc down'));
      addBtn()!.click();
      await flush();
      // On a main-process restart the invoke rejects; the button must re-enable so the user can
      // retry, and the rejection must not bubble (vitest fails the run on an unhandled rejection).
      expect(addBtn()!.disabled).toBe(false);
    });

    it('drops open/selected state when templates are gated off, so it never reappears stale across a flow transition', async () => {
      wireMonitorPane();
      await flush();
      const lib = {
        templates: [
          { ref: 'pr-review', name: 'PR review checklist' },
          { ref: 'ticket-grooming', name: 'Ticket grooming' },
        ],
        defaultRef: 'ticket-grooming',
      };
      await loadRepoWithTemplates('/repoA', [], lib);
      toggle()!.click(); // open it
      await flush();
      pick()!.value = 'pr-review'; // pick a NON-default
      pick()!.dispatchEvent(new Event('change'));

      // Flow advances out of in_progress → main gates the library off (templates: []).
      monitor.listTemplates.mockResolvedValue({ templates: [] });
      window.dispatchEvent(new Event(FLOW_CHANGED_EVENT));
      await flush();
      expect(toggle()).toBeNull(); // disclosure gone

      // Flow re-enters a step with templates → the disclosure must return COLLAPSED with the bound
      // default, not reopened with the stale 'pr-review' selection (the state leak).
      monitor.listTemplates.mockResolvedValue(lib);
      window.dispatchEvent(new Event(FLOW_CHANGED_EVENT));
      await flush();
      expect(toggle()!.getAttribute('aria-expanded')).toBe('false');
      toggle()!.click();
      await flush();
      expect(pick()!.value).toBe('ticket-grooming'); // bound default, not the stale 'pr-review'
    });

    it('Escape inside the open picker collapses it and returns focus to the toggle', async () => {
      wireMonitorPane();
      await flush();
      await loadRepoWithTemplates('/repoA', [], {
        templates: [{ ref: 'ticket-grooming', name: 'Ticket grooming' }],
      });
      toggle()!.click();
      await flush();
      pick()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await flush();
      expect(pick()).toBeNull();
      expect(document.activeElement).toBe(toggle());
    });
  });

  // Every todo mutation crosses renderer→main IPC; a main-process restart rejects the invoke.
  // None of these must surface as an unhandled renderer rejection (vitest fails the run on one),
  // and each keeps the user's current UI state on failure (§16.4).
  describe('IPC-rejection hardening (§16.4)', () => {
    it('a rejected todoReorder leaves the displayed order unchanged', async () => {
      wireMonitorPane();
      await flush();
      await loadRepo('/repoA', [makeTodo({ id: 'a', text: 'first', order: 1 }), makeTodo({ id: 'b', text: 'second', order: 2 })]);
      monitor.todoReorder.mockRejectedValueOnce(new Error('ipc down'));
      (rows()[0].querySelector('.todo-down') as HTMLButtonElement).click();
      await flush();
      expect(rows().map((r) => r.querySelector('.tx')!.textContent)).toEqual(['first', 'second']);
    });

    it('a rejected todoSetStatus (done toggle) is handled', async () => {
      wireMonitorPane();
      await flush();
      await loadRepo('/repoA', [makeTodo({ id: 'a', text: 'task' })]);
      monitor.todoSetStatus.mockRejectedValueOnce(new Error('ipc down'));
      (rows()[0].querySelector('.chk') as HTMLButtonElement).click();
      await flush();
      expect(rows().map((r) => r.querySelector('.tx')!.textContent)).toEqual(['task']);
    });

    it('a rejected manual todoAdd keeps the typed text in the input', async () => {
      wireMonitorPane();
      await flush();
      await loadRepo('/repoA', []);
      const input = document.getElementById('todo-new') as HTMLTextAreaElement;
      input.value = 'keep me';
      monitor.todoAdd.mockRejectedValueOnce(new Error('ipc down'));
      (document.getElementById('todo-add-btn') as HTMLButtonElement).click();
      await flush();
      expect((document.getElementById('todo-new') as HTMLTextAreaElement).value).toBe('keep me');
    });

    it('a rejected todoUpdate keeps the row in the edit state', async () => {
      wireMonitorPane();
      await flush();
      await loadRepo('/repoA', [makeTodo({ id: 'a', text: 'task' })]);
      (rows()[0].querySelector('.todo-edit') as HTMLButtonElement).click();
      monitor.todoUpdate.mockRejectedValueOnce(new Error('ipc down'));
      (rows()[0].querySelector('.todo-save') as HTMLButtonElement).click();
      await flush();
      expect((rows()[0].querySelector('.tx') as HTMLElement).contentEditable).toBe('true');
    });

    it('a rejected deferred todoDelete is handled', async () => {
      vi.useFakeTimers();
      try {
        wireMonitorPane();
        await vi.advanceTimersByTimeAsync(0);
        monitor.todoList.mockResolvedValue([makeTodo({ id: 'a', text: 'task', repoKey: '/repoA' })]);
        handlers.cwdChanged!({ sessionId: 's1', cwd: '/repoA', repoKey: '/repoA' });
        await vi.advanceTimersByTimeAsync(0);
        monitor.todoDelete.mockRejectedValueOnce(new Error('ipc down'));
        (rows()[0].querySelector('.todo-delete') as HTMLButtonElement).click();
        (rows()[0].querySelector('.todo-delete-confirm') as HTMLButtonElement).click();
        await vi.advanceTimersByTimeAsync(60_000); // TODO_UNDO_MS → deferred delete fires and rejects
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // Two tabs in one document must not collide on the picker's aria-controls id (relocatability/a11y).
  describe('template-picker id uniqueness across instances (§4.1 / UI-STANDARDS)', () => {
    const flush = () => new Promise((r) => setTimeout(r, 0));
    function makeTab() {
      const todoListEl = document.createElement('div');
      const todoCountEl = document.createElement('span');
      document.body.append(todoListEl, todoCountEl);
      const monitor = {
        todoList: vi.fn(async () => []),
        todoAdd: vi.fn(async () => []),
        todoUpdate: vi.fn(async () => []),
        todoReorder: vi.fn(async () => []),
        todoSetStatus: vi.fn(async () => []),
        todoDelete: vi.fn(async () => []),
        listTemplates: vi.fn(async () => ({ templates: [{ ref: 'pr-review', name: 'PR review' }] })),
        instantiateTemplate: vi.fn(async () => []),
      } as never;
      const tab = createTodoTab({ todoListEl, todoCountEl, monitor, doInject: vi.fn() });
      return { tab, todoListEl };
    }

    it('gives each instance a distinct picker id and keeps aria-controls wired to its own group', async () => {
      const a = makeTab();
      const b = makeTab();
      a.tab.onRepoChanged('/repoA');
      b.tab.onRepoChanged('/repoB');
      await flush();
      const open = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('.tmpl-toggle')!.click();
      open(a.todoListEl);
      open(b.todoListEl);
      await flush();

      const ctrlA = a.todoListEl.querySelector('.tmpl-toggle')!.getAttribute('aria-controls')!;
      const ctrlB = b.todoListEl.querySelector('.tmpl-toggle')!.getAttribute('aria-controls')!;
      const groupA = a.todoListEl.querySelector('.tmpl-picker')!.id;
      const groupB = b.todoListEl.querySelector('.tmpl-picker')!.id;
      expect(ctrlA).not.toBe(ctrlB); // no duplicate ID across panes
      expect(groupA).toBe(ctrlA); // each toggle controls its OWN group
      expect(groupB).toBe(ctrlB);
    });
  });
});
