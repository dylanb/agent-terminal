// Capture tab (§15 / §16.2): semantic blocks (report/finding/tool/diff/capture),
// command history, and their toolbars (Dismiss all, Clear commands). All user text is
// set via textContent, never innerHTML, so captured bytes cannot inject markup.
// Reaches the Todo tab only through the narrow TodoSink (§16.2 Add to todo + Undo).

import type { CommandSummary, MonitorApi, MonitorEvent, MonitorEventType, TodoSource, TodoSourceType } from '../../shared/ipc';
import { dismissButton, doInject, TODO_UNDO_MS } from './paneActions';
import type { TodoSink } from './todoTab';

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

export interface CaptureTab {
  /** Render a stored event (replay or live); deduped by id so each renders once. */
  appendBlock(event: MonitorEvent): void;
  /** Drop a rendered block/finding by id when main retracts it (superseded, §15.3). */
  removeBlock(eventId: string): void;
  renderCommands(commands: CommandSummary[]): void;
}

export interface CaptureTabDeps {
  blocksEl: HTMLElement;
  historyEl: HTMLElement;
  monitor: Pick<MonitorApi, 'dismiss' | 'dismissAll' | 'clearCommands' | 'learnChrome'>;
  todoSink: TodoSink;
}

export function createCaptureTab(deps: CaptureTabDeps): CaptureTab {
  const { blocksEl, historyEl, monitor, todoSink } = deps;
  const rendered = new Set<string>();
  // Findings whose parent report has not rendered yet (replay/live ordering safety).
  const orphans = new Map<string, MonitorEvent[]>();

  function badgeLabel(type: MonitorEventType): string {
    return TYPE_LABELS[type] ?? type;
  }

  /** Insert / Insert & submit (§16.2) — command-output blocks. */
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

  /**
   * Add to todo (§16.2) — appends a todo, then shows an in-place Undo for
   * TODO_UNDO_MS. `commit` (dismiss source + remove block) runs only once that
   * window elapses, so Undo can delete the new todo and leave the block intact.
   */
  function addToTodoAction(text: string, source: TodoSource, commit: () => void): HTMLElement {
    const actions = document.createElement('div');
    actions.className = 'capture-actions';

    function showAdd(): void {
      actions.replaceChildren();
      const add = document.createElement('button');
      add.className = 'add-to-todo';
      add.textContent = 'Add to todo';
      add.addEventListener('click', onAdd);
      actions.append(add);
    }

    async function onAdd(): Promise<void> {
      if (!todoSink.currentRepoKey()) return;
      showUndo(await todoSink.addFromCapture(text, source));
    }

    function showUndo(added: { repoKey: string; id: string } | null): void {
      actions.replaceChildren();
      const note = document.createElement('span');
      note.className = 'added-note';
      note.textContent = 'Added to todo';
      const undo = document.createElement('button');
      undo.className = 'undo-add-to-todo';
      undo.textContent = 'Undo';
      const timer = setTimeout(commit, TODO_UNDO_MS);
      undo.addEventListener('click', async () => {
        clearTimeout(timer);
        if (added) await todoSink.deleteTodo(added.repoKey, added.id);
        showAdd(); // source block is never dismissed on undo
      });
      actions.append(note, undo);
    }

    showAdd();
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
      addToTodoAction(event.text, { type: 'finding', eventId: event.id }, () => {
        monitor.dismiss(event.id); // also drop from the store so replay won't resurrect it
        el.remove();
      }),
      dismissButton('Dismiss finding', () => {
        monitor.dismiss(event.id);
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
    // Mark as chrome (§15.x): teach main this block is agent-UI furniture; main learns
    // its glyphs and retracts it (we also drop it optimistically, like Dismiss).
    const markChrome = document.createElement('button');
    markChrome.className = 'mark-chrome';
    markChrome.textContent = 'Mark as chrome';
    markChrome.addEventListener('click', () => {
      monitor.learnChrome(event.id, event.text);
      block.remove();
    });
    meta.append(
      badge,
      timeEl,
      markChrome,
      dismissButton(`Dismiss ${badgeLabel(event.type)} at ${time}`, () => {
        monitor.dismiss(event.id); // main cascades to child findings (§15.6)
        block.remove();
      }),
    );
    block.append(meta);

    if (event.type === 'report') {
      // Whole-report Add to todo, a fallback pre (removed once findings arrive), and a
      // container the findings nest into in natural order.
      block.append(
        addToTodoAction(event.text, { type: 'report', eventId: event.id }, () => {
          monitor.dismiss(event.id); // cascades to child findings (§15.6)
          block.remove();
        }),
      );
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
          : addToTodoAction(event.text, { type: sourceTypeFor(event.type), eventId: event.id }, () => {
              monitor.dismiss(event.id); // also drop from the store so replay won't resurrect it
              block.remove();
            });
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

  /**
   * Retraction (§15.3): the scanner superseded this event with a fuller capture, so
   * drop its block. A report block contains its findings, so removing it cascades;
   * also clears the dedup/orphan bookkeeping so a stale id can never linger.
   */
  function removeBlock(eventId: string): void {
    rendered.delete(eventId);
    orphans.delete(eventId);
    for (const el of blocksEl.querySelectorAll('[data-event-id]')) {
      if ((el as HTMLElement).dataset.eventId === eventId) {
        el.remove();
        return;
      }
    }
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

      // Command capture moved to the terminal pane's Capture-selection button: with no
      // selection it captures the latest command's output to a todo (§16.2).
      entry.append(cmd, chip);
      historyEl.appendChild(entry);
    }
  }

  // Command-history toolbar — Clear commands (Dismiss-all for commands; §16.2). Main
  // drops only finished commands and re-renders via onCommandsChanged; no optimistic
  // wipe, so a still-running command is never momentarily hidden.
  const cmdToolbar = document.createElement('div');
  cmdToolbar.className = 'commands-toolbar';
  const clearCommands = document.createElement('button');
  clearCommands.id = 'clear-commands';
  clearCommands.textContent = 'Clear commands';
  clearCommands.addEventListener('click', () => monitor.clearCommands());
  cmdToolbar.appendChild(clearCommands);
  historyEl.parentNode?.insertBefore(cmdToolbar, historyEl);

  // Blocks toolbar — Dismiss all (§15.6); the pane owns it (§9.1, no terminal coupling).
  const toolbar = document.createElement('div');
  toolbar.className = 'blocks-toolbar';
  const dismissAll = document.createElement('button');
  dismissAll.id = 'dismiss-all';
  dismissAll.textContent = 'Dismiss all';
  dismissAll.addEventListener('click', () => {
    monitor.dismissAll();
    blocksEl.innerHTML = '';
    rendered.clear();
    orphans.clear();
  });
  toolbar.appendChild(dismissAll);
  blocksEl.parentNode?.insertBefore(toolbar, blocksEl);

  return { appendBlock, removeBlock, renderCommands };
}
