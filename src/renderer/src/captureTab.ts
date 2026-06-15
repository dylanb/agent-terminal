// Capture tab (§15 / §16.2): semantic blocks (report/finding/tool/diff/capture),
// command history, and their toolbars (Dismiss all, Clear commands). All user text is
// set via textContent, never innerHTML, so captured bytes cannot inject markup.
// Reaches the Todo tab only through the narrow TodoSink (§16.2 Add to todo + Undo).

import type { CommandSummary, MonitorApi, MonitorEvent, MonitorEventType, SelectionRange, TodoSource, TodoSourceType } from '../../shared/ipc';
import { dismissButton, doInject, REVEAL_HIGHLIGHT_MS, REVEAL_TERMINAL_EVENT, TODO_UNDO_MS } from './paneActions';
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
  /** Cross-highlight (§16.8): scroll to and border-highlight the block whose on-screen
   *  span covers `absRow` (the terminal row the user double-clicked); a no-op if none. */
  revealByRow(absRow: number): void;
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
  // Cross-highlight (§16.8): each top-level block's on-screen span, and the live
  // self-clearing highlight timer per block (re-reveal resets it).
  const ranges = new Map<string, SelectionRange>();
  const revealTimers = new Map<string, ReturnType<typeof setTimeout>>();

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
    // Cross-highlight (§16.8): a finding carries its own on-screen span, so double-clicking
    // it reveals just that chunk's rows. stopPropagation keeps the click from bubbling to the
    // enclosing report block (which would reveal the whole report instead).
    if (event.range) {
      ranges.set(event.id, event.range);
      el.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        const range = ranges.get(event.id);
        if (range) window.dispatchEvent(new CustomEvent(REVEAL_TERMINAL_EVENT, { detail: { range } }));
      });
    }
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

  /** Any rendered event element (a top-level block or a nested finding) by id (§16.8). */
  function elById(id: string): HTMLElement | null {
    for (const el of blocksEl.querySelectorAll('[data-event-id]')) {
      if ((el as HTMLElement).dataset.eventId === id) return el as HTMLElement;
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
    // tool-use / diff are emitted only to carve their rows out of reports (§15.x); they
    // are agent furniture, not to-do candidates, so the pane never renders them as cards.
    if (event.type === 'tool-use' || event.type === 'diff') return;
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

    // Cross-highlight (§16.8): remember the block's on-screen span and let a double-click
    // anywhere in it (nested findings included, via bubbling) reveal those terminal rows.
    // Manual captures carry no range, so they simply don't participate.
    if (event.range) {
      ranges.set(event.id, event.range);
      block.addEventListener('dblclick', () => {
        const range = ranges.get(event.id);
        if (range) window.dispatchEvent(new CustomEvent(REVEAL_TERMINAL_EVENT, { detail: { range } }));
      });
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
    ranges.delete(eventId);
    const timer = revealTimers.get(eventId);
    if (timer) {
      clearTimeout(timer);
      revealTimers.delete(eventId);
    }
    for (const el of blocksEl.querySelectorAll('[data-event-id]')) {
      if ((el as HTMLElement).dataset.eventId === eventId) {
        el.remove();
        return;
      }
    }
  }

  /** Scroll to + highlight the element whose span covers `absRow` for REVEAL_HIGHLIGHT_MS;
   *  re-revealing restarts its timer (§16.8). When a finding and its report both cover the
   *  row, the **most specific** (smallest span) wins, so a chunk highlights on its own. */
  function revealByRow(absRow: number): void {
    let bestId: string | null = null;
    let bestSpan = Infinity;
    for (const [id, range] of ranges) {
      if (absRow < range.start.y || absRow > range.end.y) continue;
      if (!elById(id)) {
        ranges.delete(id); // element dismissed directly (not via removeBlock); self-heal
        continue;
      }
      const span = range.end.y - range.start.y;
      if (span < bestSpan) {
        bestSpan = span;
        bestId = id;
      }
    }
    if (bestId === null) return;
    const id = bestId;
    const el = elById(id)!;
    el.scrollIntoView({ block: 'nearest' });
    el.classList.add('revealed');
    const prev = revealTimers.get(id);
    if (prev) clearTimeout(prev);
    revealTimers.set(
      id,
      setTimeout(() => {
        el.classList.remove('revealed');
        revealTimers.delete(id);
      }, REVEAL_HIGHLIGHT_MS),
    );
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

  return { appendBlock, removeBlock, revealByRow, renderCommands };
}
