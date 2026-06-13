// Action window (§16): a tabbed pane — a Capture tab (status strip + command
// history + semantic blocks, §15) and a Todo tab (persistent, repo-scoped, §16.3).
// Architectural rule (§9.1): talks ONLY to window.monitor.* — never to the terminal
// pane, the renderer xterm, or the selection model. All user-controlled text is set
// via textContent, never innerHTML, so captured bytes cannot inject markup.
//
// Injection model (§16.2): semantic captures (report/finding/manual capture) offer
// Add to todo + Dismiss (no inject); command-output keeps Insert / Insert & submit;
// command history gains Clear commands. Focus rule: Insert moves focus to the
// terminal (a decoupled window event the terminal pane listens for), Insert & submit
// keeps focus here.

import type {
  CommandSummary,
  MonitorEvent,
  MonitorEventType,
  MonitorUpdateMsg,
  TabId,
  TodoItem,
  TodoSource,
  TodoSourceType,
} from '../../shared/ipc';

// Decoupled focus signal (§16.2): the monitor pane must not import terminal modules,
// so it asks for terminal focus via a window event the terminal pane subscribes to.
export const FOCUS_TERMINAL_EVENT = 'app:focus-terminal';

// While quiet, the "quiet for Ns" counter is re-rendered on this cadence (§8.3).
const QUIET_TICK_MS = 1000;

/** Friendly badge labels; unknown future types fall back to the raw type, never dropped (§15.6). */
const TYPE_LABELS: Record<string, string> = {
  capture: 'capture',
  report: 'report',
  finding: 'finding',
  'tool-use': 'tool',
  diff: 'diff',
  completion: 'completion',
  'command-output': 'command',
};

/** Map a captured event's type to a todo source type (§16.3); unknowns → 'capture'. */
function sourceTypeFor(type: MonitorEventType): TodoSourceType {
  switch (type) {
    case 'report':
    case 'finding':
    case 'capture':
    case 'command-output':
      return type;
    default:
      return 'capture';
  }
}

export function wireMonitorPane(): void {
  const statusEl = document.getElementById('monitor-status')!;
  const historyEl = document.getElementById('command-history')!;
  const blocksEl = document.getElementById('monitor-blocks')!;
  const tabCaptureEl = document.getElementById('tab-capture')!;
  const tabTodoEl = document.getElementById('tab-todo')!;
  const panelCaptureEl = document.getElementById('panel-capture')!;
  const panelTodoEl = document.getElementById('panel-todo')!;
  const unreadDotEl = document.getElementById('capture-unread')!;
  const todoCountEl = document.getElementById('todo-count')!;

  let alive = true;
  let last: MonitorUpdateMsg | null = null;
  let quietTick: ReturnType<typeof setInterval> | null = null;
  let quietCounterEl: HTMLElement | null = null;
  let activeTab: TabId = 'capture';
  let currentRepoKey: string | null = null;
  let todos: TodoItem[] = [];
  // A repo swap is blocked while a todo edit is open (§16.3); the pending key is
  // applied once the edit resolves so the in-flight edit writes to its own repo.
  let editingId: string | null = null;
  let pendingRepoKey: string | null = null;
  const todoListEl = document.getElementById('todo-list')!;
  const rendered = new Set<string>();
  // Findings whose parent report has not rendered yet (replay/live ordering safety).
  const orphans = new Map<string, MonitorEvent[]>();

  function badgeLabel(type: MonitorEventType): string {
    return TYPE_LABELS[type] ?? type;
  }

  function requestTerminalFocus(): void {
    window.dispatchEvent(new CustomEvent(FOCUS_TERMINAL_EVENT));
  }

  // §16.2 focus rule: Insert → terminal (user finishes there); Insert & submit → stays.
  function doInject(text: string, submit: boolean): void {
    window.monitor.inject({ text, submit });
    if (!submit) requestTerminalFocus();
  }

  function dismissButton(label: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'dismiss';
    btn.textContent = '×';
    btn.setAttribute('aria-label', label);
    btn.addEventListener('click', onClick);
    return btn;
  }

  /** Insert / Insert & submit (§16.2) — command-output blocks and (PR5) todos. */
  function injectActions(text: string): HTMLElement {
    const actions = document.createElement('div');
    actions.className = 'capture-actions';
    const insert = document.createElement('button');
    insert.textContent = 'Insert into agent';
    insert.addEventListener('click', () => doInject(text, false));
    const submit = document.createElement('button');
    submit.textContent = 'Insert & submit';
    submit.addEventListener('click', () => doInject(text, true));
    actions.append(insert, submit);
    return actions;
  }

  /** Add to todo (§16.2) — appends a todo and removes the source block from Capture. */
  function addToTodoAction(text: string, source: TodoSource, onAdded: () => void): HTMLElement {
    const actions = document.createElement('div');
    actions.className = 'capture-actions';
    const add = document.createElement('button');
    add.className = 'add-to-todo';
    add.textContent = 'Add to todo';
    add.addEventListener('click', async () => {
      if (currentRepoKey) setTodos(await window.monitor.todoAdd(currentRepoKey, text, source));
      if (source.eventId) window.monitor.dismiss(source.eventId); // also drop from the store so replay won't resurrect it
      onAdded();
    });
    actions.append(add);
    return actions;
  }

  function renderFinding(event: MonitorEvent): HTMLElement {
    const el = document.createElement('div');
    el.className = 'finding';
    el.dataset.eventId = event.id;
    const pre = document.createElement('pre');
    pre.className = 'capture-text';
    pre.textContent = event.text;
    el.append(
      pre,
      addToTodoAction(event.text, { type: 'finding', eventId: event.id }, () => el.remove()),
      dismissButton('Dismiss finding', () => {
        window.monitor.dismiss(event.id);
        el.remove();
      }),
    );
    return el;
  }

  function groupById(id: string): Element | null {
    for (const el of blocksEl.querySelectorAll('.capture-block')) {
      if ((el as HTMLElement).dataset.eventId === id) return el;
    }
    return null;
  }

  function attachFinding(event: MonitorEvent): void {
    const group = groupById(event.parentId!);
    if (!group) {
      const list = orphans.get(event.parentId!) ?? [];
      list.push(event);
      orphans.set(event.parentId!, list);
      return;
    }
    group.querySelector('pre.report-full')?.remove();
    group.querySelector('.findings')!.appendChild(renderFinding(event));
  }

  function appendBlock(event: MonitorEvent): void {
    // Replay (§8.4) and the live monitor:event stream can both deliver the same id;
    // render each stored event exactly once.
    if (rendered.has(event.id)) return;
    rendered.add(event.id);

    if (event.type === 'finding') {
      attachFinding(event);
      return;
    }

    const time = new Date(event.capturedAt).toLocaleTimeString();
    const block = document.createElement('div');
    block.className = 'capture-block';
    block.dataset.eventId = event.id;
    block.dataset.type = event.type;
    block.setAttribute('role', 'group');
    block.setAttribute('aria-label', `${badgeLabel(event.type)} at ${time}`);

    const meta = document.createElement('div');
    meta.className = 'capture-meta';
    const badge = document.createElement('span');
    badge.className = 'capture-badge';
    badge.dataset.type = event.type;
    badge.textContent = badgeLabel(event.type);
    const timeEl = document.createElement('span');
    timeEl.className = 'capture-time';
    timeEl.textContent = time + (event.truncated ? ' · truncated' : '');
    meta.append(
      badge,
      timeEl,
      dismissButton(`Dismiss ${badgeLabel(event.type)} at ${time}`, () => {
        window.monitor.dismiss(event.id); // main cascades to child findings (§15.6)
        block.remove();
      }),
    );
    block.append(meta);

    if (event.type === 'report') {
      // Whole-report Add to todo, a fallback pre (removed once findings arrive), and a
      // container the findings nest into in natural order.
      block.append(addToTodoAction(event.text, { type: 'report', eventId: event.id }, () => block.remove()));
      const full = document.createElement('pre');
      full.className = 'capture-text report-full';
      full.textContent = event.text;
      const findings = document.createElement('div');
      findings.className = 'findings';
      block.append(full, findings);
    } else {
      const pre = document.createElement('pre');
      pre.className = 'capture-text';
      pre.textContent = event.text;
      // command-output keeps Insert / Insert & submit; every other capture is semantic
      // → Add to todo + Dismiss only (§16.2).
      const actions =
        event.type === 'command-output'
          ? injectActions(event.text)
          : addToTodoAction(event.text, { type: sourceTypeFor(event.type), eventId: event.id }, () => block.remove());
      block.append(pre, actions);
    }

    // Newest-first: prepend top-level blocks (§15.6 / v2.6).
    blocksEl.insertBefore(block, blocksEl.firstChild);

    const pending = orphans.get(event.id);
    if (pending) {
      orphans.delete(event.id);
      for (const f of pending) attachFinding(f);
    }
  }

  function renderStatus(): void {
    const state = last?.agentState ?? 'quiet';
    statusEl.innerHTML = '';
    quietCounterEl = null;
    const items: Array<[string, string, boolean]> = [
      ['session', alive ? 'alive' : 'exited', alive],
      ['agent', state === 'active' ? 'working' : 'quiet', state === 'active'],
      ['full-screen', last?.altScreen ? 'yes' : 'no', !!last?.altScreen],
      ['paste mode', last?.bracketedPaste ? 'on' : 'off', !!last?.bracketedPaste],
    ];
    for (const [label, value, on] of items) {
      const chip = document.createElement('span');
      chip.className = `status-chip${on ? ' on' : ''}`;
      chip.dataset.status = label;
      chip.textContent = `${label}: ${value}`;
      if (label === 'agent' && state === 'quiet') {
        quietCounterEl = document.createElement('span');
        quietCounterEl.className = 'quiet-counter';
        quietCounterEl.setAttribute('aria-hidden', 'true');
        chip.appendChild(quietCounterEl);
      }
      statusEl.appendChild(chip);
    }
    updateQuietCounter();
  }

  function updateQuietCounter(): void {
    if (!quietCounterEl) return;
    const since = last?.quietSince;
    quietCounterEl.textContent = since
      ? ` for ${Math.max(0, Math.round((Date.now() - since) / 1000))}s`
      : '';
  }

  function renderCommands(commands: CommandSummary[]): void {
    historyEl.innerHTML = '';
    // CommandSummary is newest-last; show newest at the top (§15.6 / v2.6).
    for (const c of [...commands].reverse()) {
      const entry = document.createElement('div');
      entry.className = 'command-entry';
      entry.dataset.commandId = c.id;

      const cmd = document.createElement('span');
      cmd.className = 'command-text';
      cmd.textContent = c.command;

      const chip = document.createElement('span');
      chip.className = 'exit-chip';
      chip.textContent = c.running ? 'running' : `exit ${c.exitCode ?? '?'}`;
      if (c.truncated) chip.textContent += ' (truncated)';

      const capture = document.createElement('button');
      capture.textContent = 'Capture';
      capture.setAttribute('aria-label', `Capture output of: ${c.command}`);
      // Fail-closed: main materializes the block; it flows back via monitor:event only
      // if the id is still valid (§15.4). No optimistic render.
      capture.addEventListener('click', () => window.monitor.captureCommand(c.id));

      entry.append(cmd, chip, capture);
      historyEl.appendChild(entry);
    }
  }

  // ---- Todo tab (§16.3 / §16.4) — count here; full list render in renderTodos. ----

  function updateTodoCount(): void {
    todoCountEl.textContent = String(todos.filter((t) => t.status === 'active').length);
  }

  function setTodos(list: TodoItem[]): void {
    todos = list;
    updateTodoCount();
    renderTodos();
  }

  function refreshTodos(): void {
    if (!currentRepoKey) return;
    void window.monitor.todoList(currentRepoKey).then(setTodos);
  }

  function applyRepoSwap(repoKey: string): void {
    currentRepoKey = repoKey;
    refreshTodos();
  }

  // A repo swap arriving mid-edit (§16.3) is deferred until the edit resolves.
  function onRepoChanged(repoKey: string): void {
    if (editingId !== null) {
      pendingRepoKey = repoKey;
      renderTodos(); // surface the blocked-swap notice
      return;
    }
    applyRepoSwap(repoKey);
  }

  // After Save/Cancel: drop edit state and apply any swap that was blocked.
  function resolveEdit(): void {
    editingId = null;
    if (pendingRepoKey !== null) {
      const next = pendingRepoKey;
      pendingRepoKey = null;
      applyRepoSwap(next);
    } else {
      renderTodos();
    }
  }

  function todoInjectActions(t: TodoItem): HTMLElement {
    const actions = document.createElement('div');
    actions.className = 'capture-actions';
    // Active → completing the todo marks it done; done → re-copy moves it back (§16.4).
    const nextStatus = t.status === 'active' ? 'done' : 'active';
    const insert = document.createElement('button');
    insert.className = 'todo-insert';
    insert.textContent = 'Insert into agent';
    insert.addEventListener('click', async () => {
      doInject(t.text, false);
      setTodos(await window.monitor.todoSetStatus(t.repoKey, t.id, nextStatus));
    });
    const submit = document.createElement('button');
    submit.className = 'todo-submit';
    submit.textContent = 'Insert & submit';
    submit.addEventListener('click', async () => {
      doInject(t.text, true);
      setTodos(await window.monitor.todoSetStatus(t.repoKey, t.id, nextStatus));
    });
    actions.append(insert, submit);
    return actions;
  }

  // Editing is render state, not a DOM mutation, so a mid-edit re-render (e.g. the
  // blocked-swap notice) preserves the open editor (§16.3).
  function renderEditing(t: TodoItem): HTMLElement {
    const item = document.createElement('div');
    item.className = 'todo-item editing';
    item.dataset.todoId = t.id;
    const textarea = document.createElement('textarea');
    textarea.className = 'todo-edit-area';
    textarea.value = t.text;
    const actions = document.createElement('div');
    actions.className = 'todo-actions';
    const save = document.createElement('button');
    save.className = 'todo-save';
    save.textContent = 'Save';
    save.addEventListener('click', async () => {
      // The edit targets the list's own repo (t.repoKey), not the live cwd (§16.3).
      const list = await window.monitor.todoUpdate(t.repoKey, t.id, textarea.value);
      todos = list;
      updateTodoCount();
      resolveEdit();
    });
    const cancel = document.createElement('button');
    cancel.className = 'todo-cancel';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => resolveEdit());
    actions.append(save, cancel);
    item.append(textarea, actions);
    return item;
  }

  function renderTodoItem(t: TodoItem, ordered: TodoItem[], index: number): HTMLElement {
    if (t.id === editingId) return renderEditing(t);

    const item = document.createElement('div');
    item.className = `todo-item${t.status === 'done' ? ' done' : ''}`;
    item.dataset.todoId = t.id;

    const handle = document.createElement('span');
    handle.className = 'drag-handle';
    handle.setAttribute('aria-hidden', 'true');
    handle.textContent = '⠿';
    item.draggable = t.status === 'active';

    const text = document.createElement('span');
    text.className = 'todo-text';
    text.textContent = t.text;

    const actions = document.createElement('div');
    actions.className = 'todo-actions';

    if (t.status === 'active') {
      const up = document.createElement('button');
      up.className = 'todo-up';
      up.textContent = '↑';
      up.setAttribute('aria-label', 'Move up');
      up.disabled = index === 0;
      up.addEventListener('click', () => reorderBy(ordered, index, index - 1));
      const down = document.createElement('button');
      down.className = 'todo-down';
      down.textContent = '↓';
      down.setAttribute('aria-label', 'Move down');
      down.disabled = index === ordered.length - 1;
      down.addEventListener('click', () => reorderBy(ordered, index, index + 1));
      const edit = document.createElement('button');
      edit.className = 'todo-edit';
      edit.textContent = 'Edit';
      edit.addEventListener('click', () => {
        editingId = t.id;
        renderTodos();
      });
      actions.append(up, down, edit);
    }

    const del = document.createElement('button');
    del.className = 'todo-delete dismiss';
    del.textContent = '×';
    del.setAttribute('aria-label', 'Delete todo');
    del.addEventListener('click', async () => setTodos(await window.monitor.todoDelete(t.repoKey, t.id)));
    actions.append(del);

    item.append(handle, text, todoInjectActions(t), actions);
    return item;
  }

  function reorderBy(ordered: TodoItem[], from: number, to: number): void {
    if (to < 0 || to >= ordered.length || !currentRepoKey) return;
    const ids = ordered.map((t) => t.id);
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved);
    void window.monitor.todoReorder(currentRepoKey, ids).then(setTodos);
  }

  // ---- Tabs (§16.1) ----

  function selectTab(tab: TabId, persist = true): void {
    activeTab = tab;
    const onCapture = tab === 'capture';
    panelCaptureEl.hidden = !onCapture;
    panelTodoEl.hidden = onCapture;
    tabCaptureEl.setAttribute('aria-selected', String(onCapture));
    tabTodoEl.setAttribute('aria-selected', String(!onCapture));
    if (onCapture) unreadDotEl.hidden = true;
    else refreshTodos();
    if (persist) window.monitor.setSettings({ lastTab: tab });
  }
  tabCaptureEl.addEventListener('click', () => selectTab('capture'));
  tabTodoEl.addEventListener('click', () => selectTab('todo'));

  function stopQuietTick(): void {
    if (quietTick) clearInterval(quietTick);
    quietTick = null;
  }

  function pullCommands(): void {
    void window.monitor.commands().then(renderCommands);
  }

  // Command-history toolbar — Clear commands (Dismiss-all for commands; §16.2).
  const cmdToolbar = document.createElement('div');
  cmdToolbar.className = 'commands-toolbar';
  const clearCommands = document.createElement('button');
  clearCommands.id = 'clear-commands';
  clearCommands.textContent = 'Clear commands';
  clearCommands.addEventListener('click', () => {
    window.monitor.clearCommands();
    historyEl.innerHTML = '';
  });
  cmdToolbar.appendChild(clearCommands);
  historyEl.parentNode?.insertBefore(cmdToolbar, historyEl);

  // Blocks toolbar — Dismiss all (§15.6); the pane owns it (§9.1, no terminal coupling).
  const toolbar = document.createElement('div');
  toolbar.className = 'blocks-toolbar';
  const dismissAll = document.createElement('button');
  dismissAll.id = 'dismiss-all';
  dismissAll.textContent = 'Dismiss all';
  dismissAll.addEventListener('click', () => {
    window.monitor.dismissAll();
    blocksEl.innerHTML = '';
    rendered.clear();
    orphans.clear();
  });
  toolbar.appendChild(dismissAll);
  blocksEl.parentNode?.insertBefore(toolbar, blocksEl);

  window.monitor.onUpdate((msg) => {
    last = msg;
    renderStatus();
    pullCommands();
    stopQuietTick();
    if (msg.agentState === 'quiet') quietTick = setInterval(updateQuietCounter, QUIET_TICK_MS);
  });

  window.monitor.onEvent((event) => {
    appendBlock(event);
    // Unread dot (§16.1): a capture arrived while another tab was active.
    if (activeTab !== 'capture') unreadDotEl.hidden = false;
  });

  window.monitor.onCommandsChanged(() => pullCommands());

  // Repo-scoped todos (§16.3): a repo-key change swaps the displayed list, unless
  // a todo edit is open — then it is deferred (onRepoChanged) until the edit resolves.
  window.monitor.onCwdChanged((m) => onRepoChanged(m.repoKey));

  window.monitor.onExit(() => {
    alive = false;
    renderStatus();
  });

  void window.monitor.replay().then((events) => {
    for (const e of events) appendBlock(e);
  });
  pullCommands();

  // Restore the remembered tab (§16.1 / §16.6) before first paint of either panel.
  void window.monitor.getSettings().then((s) => selectTab(s.lastTab, false));

  renderStatus();

  // Manual-add row + active list + collapsible Done section (§16.4).
  function renderTodos(): void {
    todoListEl.innerHTML = '';

    if (pendingRepoKey !== null) {
      const notice = document.createElement('div');
      notice.className = 'swap-blocked';
      notice.textContent = 'Directory changed — save or cancel this edit to switch todo lists.';
      todoListEl.appendChild(notice);
    }

    const addRow = document.createElement('div');
    addRow.className = 'todo-add';
    const input = document.createElement('textarea');
    input.id = 'todo-new';
    input.className = 'todo-new';
    input.setAttribute('aria-label', 'New todo');
    const addBtn = document.createElement('button');
    addBtn.id = 'todo-add-btn';
    addBtn.textContent = 'Add';
    addBtn.addEventListener('click', async () => {
      const text = input.value.trim();
      if (!text || !currentRepoKey) return;
      setTodos(await window.monitor.todoAdd(currentRepoKey, text, { type: 'manual' }));
      input.value = '';
    });
    addRow.append(input, addBtn);
    todoListEl.appendChild(addRow);

    const active = todos.filter((t) => t.status === 'active').sort((a, b) => a.order - b.order);
    const activeList = document.createElement('div');
    activeList.className = 'todo-active';
    active.forEach((t, i) => activeList.appendChild(renderTodoItem(t, active, i)));
    todoListEl.appendChild(activeList);

    const done = todos.filter((t) => t.status === 'done').sort((a, b) => a.order - b.order);
    const doneSection = document.createElement('details');
    doneSection.className = 'todo-done';
    const summary = document.createElement('summary');
    summary.textContent = `Done (${done.length})`;
    doneSection.appendChild(summary);
    done.forEach((t) => doneSection.appendChild(renderTodoItem(t, done, 0)));
    todoListEl.appendChild(doneSection);

    wireDragReorder(activeList, active);
  }

  // HTML5 drag reorder of the active list (§16.4); the up/down buttons are the
  // keyboard/a11y path. The reordered ids persist via todo:reorder.
  // TODO(dylan): pointer drag is exercised only in the §F e2e (plan PR5 5c) — jsdom
  // has no layout/DnD; the keyboard reorder path is unit-tested. Recorded gap.
  function wireDragReorder(list: HTMLElement, ordered: TodoItem[]): void {
    let dragId: string | null = null;
    list.addEventListener('dragstart', (e) => {
      dragId = (e.target as HTMLElement).closest<HTMLElement>('.todo-item')?.dataset.todoId ?? null;
    });
    list.addEventListener('dragover', (e) => e.preventDefault());
    list.addEventListener('drop', (e) => {
      const targetId = (e.target as HTMLElement).closest<HTMLElement>('.todo-item')?.dataset.todoId;
      if (!dragId || !targetId || dragId === targetId) return;
      const ids = ordered.map((t) => t.id);
      const from = ids.indexOf(dragId);
      const to = ids.indexOf(targetId);
      if (from < 0 || to < 0) return;
      reorderBy(ordered, from, to);
    });
  }
}
