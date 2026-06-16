// Capture tab (§15 / §16.2): semantic blocks (report/finding/tool/diff/capture),
// command history, and their toolbars (Dismiss all, Clear commands). All user text is
// set via textContent, never innerHTML, so captured bytes cannot inject markup.
// Reaches the Todo tab only through the narrow TodoSink (§16.2 Add to todo + Undo).

import type { CommandSummary, MonitorApi, MonitorEvent, MonitorEventType, TodoSource } from '../../shared/ipc';
import {
  CAPTURE_RANGE_ADD_EVENT,
  CAPTURE_RANGE_REMOVE_EVENT,
  doInject,
  REVEAL_HIGHLIGHT_MS,
  REVEAL_TERMINAL_EVENT,
  TODO_UNDO_MS,
} from './paneActions';
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

export interface CaptureTab {
  /** Render a stored event (replay or live); deduped by id so each renders once. */
  appendBlock(event: MonitorEvent): void;
  /** Drop a rendered block/finding by id when main retracts it (superseded, §15.3). */
  removeBlock(eventId: string): void;
  /** Cross-highlight (§16.8): scroll to and border-highlight the capture with this id (the
   *  terminal pane resolved the double-clicked row to it); a no-op if it is no longer shown. */
  revealById(id: string): void;
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
  // Cross-highlight (§16.8): the live self-clearing reveal-highlight timer per element
  // (re-reveal resets it). The coordinates themselves live on the terminal side, which
  // marker-anchors each span (so reflow can't stale it); this pane deals only in ids.
  const revealTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Publish a capture's span so the terminal can marker-anchor it for cross-highlight (§16.8). */
  function publishRange(event: MonitorEvent): void {
    if (!event.range) return;
    window.dispatchEvent(new CustomEvent(CAPTURE_RANGE_ADD_EVENT, { detail: { id: event.id, range: event.range } }));
  }

  /** Ask the terminal to drop the marker(s) for a removed element and any nested ones (§16.8). */
  function unpublishRange(el: HTMLElement): void {
    for (const node of [el, ...el.querySelectorAll<HTMLElement>('[data-event-id]')]) {
      const id = node.dataset.eventId;
      if (id) window.dispatchEvent(new CustomEvent(CAPTURE_RANGE_REMOVE_EVENT, { detail: { id } }));
    }
  }

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

  // Chunk selection (§16.2): a chunk is a finding, a standalone capture, or a report that
  // never split. Each carries a checkbox; the toolbar's static Add-to-todo concatenates the
  // checked chunks (appeared order) into one todo, and Dismiss-selected drops them. `seq` is
  // render order = appeared order, so the concatenation reads oldest-first.
  let chunkSeq = 0;
  const chunkRegistry = new Map<string, { text: string; seq: number }>();
  let undoPending = false;
  // Chunks committed to the pending Add-to-todo: shown processed (dimmed + checkbox
  // disabled) until the undo window commits (then they're dismissed) or Undo reverts them.
  let processedIds: string[] = [];

  function setProcessed(ids: string[], on: boolean): void {
    for (const id of ids) {
      const el = elById(id);
      if (!el) continue;
      el.classList.toggle('chunk-processed', on);
      const cb = el.querySelector<HTMLInputElement>('.chunk-check');
      if (cb) cb.disabled = on;
    }
  }

  function makeChunkCheckbox(eventId: string, text: string): HTMLInputElement {
    chunkRegistry.set(eventId, { text, seq: chunkSeq++ });
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'chunk-check';
    // Distinct from the block's data-event-id so it never collides with [data-event-id]
    // lookups (elById, groupById, replay dedup counts).
    cb.dataset.chunkId = eventId;
    cb.setAttribute('aria-label', 'Select chunk to add to todo');
    cb.addEventListener('change', refreshSelectionUI);
    return cb;
  }

  function checkedChunks(): { id: string; text: string; seq: number }[] {
    return Array.from(blocksEl.querySelectorAll<HTMLInputElement>('.chunk-check'))
      .filter((c) => c.checked)
      .map((c) => ({ id: c.dataset.chunkId!, ...chunkRegistry.get(c.dataset.chunkId!)! }))
      .sort((a, b) => a.seq - b.seq);
  }

  function removeChunk(id: string): void {
    chunkRegistry.delete(id);
    const el = elById(id);
    if (el) {
      unpublishRange(el); // drop the terminal's marker for this span (§16.8)
      el.remove();
    }
  }

  function refreshSelectionUI(): void {
    const any = blocksEl.querySelector('.chunk-check:checked') !== null;
    addSelectedBtn.disabled = !any || undoPending;
    dismissSelectedBtn.disabled = !any;
  }

  // Bulk Add to todo: one undoable todo from all checked chunks. The chunks are dismissed
  // only when the undo window elapses (commit), mirroring the per-block flow it replaced.
  async function onAddSelected(): Promise<void> {
    if (undoPending || !todoSink.currentRepoKey()) return;
    const selected = checkedChunks();
    if (selected.length === 0) return;
    const ids = selected.map((c) => c.id);
    const source: TodoSource = { type: 'capture' };
    undoPending = true;
    processedIds = ids;
    setProcessed(ids, true);
    addSelectedBtn.hidden = true;
    refreshSelectionUI();
    const added = await todoSink.addFromCapture(selected.map((c) => c.text).join('\n\n'), source);
    undoSlot.replaceChildren();
    const note = document.createElement('span');
    note.className = 'added-note';
    note.textContent = 'Added to todo';
    const undo = document.createElement('button');
    undo.className = 'undo-add-to-todo';
    undo.textContent = 'Undo';
    const timer = setTimeout(() => {
      for (const id of ids) {
        monitor.dismiss(id);
        removeChunk(id);
      }
      endUndo();
    }, TODO_UNDO_MS);
    undo.addEventListener('click', async () => {
      clearTimeout(timer);
      if (added) await todoSink.deleteTodo(added.repoKey, added.id); // chunks stay; nothing dismissed
      endUndo();
    });
    undoSlot.append(note, undo);
  }

  function endUndo(): void {
    undoPending = false;
    setProcessed(processedIds, false); // no-op for committed chunks (already removed)
    processedIds = [];
    undoSlot.replaceChildren();
    addSelectedBtn.hidden = false;
    refreshSelectionUI();
  }

  function renderFinding(event: MonitorEvent): HTMLElement {
    const el = document.createElement('div');
    el.className = 'finding';
    el.dataset.eventId = event.id;
    // Cross-highlight (§16.8): a finding carries its own on-screen span, so double-clicking
    // it reveals just that chunk's rows. stopPropagation keeps the click from bubbling to the
    // enclosing report block (which would reveal the whole report instead).
    if (event.range) {
      publishRange(event);
      el.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        window.dispatchEvent(new CustomEvent(REVEAL_TERMINAL_EVENT, { detail: { id: event.id } }));
      });
    }
    const pre = document.createElement('pre');
    pre.className = 'capture-text';
    pre.textContent = event.text;
    el.append(makeChunkCheckbox(event.id, event.text), pre);
    return el;
  }

  function groupById(id: string): HTMLElement | null {
    for (const el of blocksEl.querySelectorAll<HTMLElement>('.capture-block')) {
      if (el.dataset.eventId === id) return el;
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
    // The report has split: its findings are the chunks now, so retire the whole-report
    // fallback text and its block-level checkbox.
    if (group.querySelector('pre.report-full')) {
      group.querySelector('pre.report-full')!.remove();
      group.querySelector('.report-chunk-check')?.remove();
      chunkRegistry.delete(group.dataset.eventId!);
    }
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
    meta.append(badge, timeEl, markChrome);
    block.append(meta);

    if (event.type === 'report') {
      // Until findings arrive the whole report is one selectable chunk (a block-level
      // checkbox + fallback pre); attachFinding retires both when the report splits.
      const cb = makeChunkCheckbox(event.id, event.text);
      cb.classList.add('report-chunk-check');
      const full = document.createElement('pre');
      full.className = 'capture-text report-full';
      full.textContent = event.text;
      const findings = document.createElement('div');
      findings.className = 'findings';
      block.append(cb, full, findings);
    } else {
      const pre = document.createElement('pre');
      pre.className = 'capture-text';
      pre.textContent = event.text;
      // command-output keeps Insert / Insert & submit (§16.2); every chunk also carries a
      // checkbox for the toolbar's bulk Add-to-todo / Dismiss-selected.
      block.append(makeChunkCheckbox(event.id, event.text), pre);
      if (event.type === 'command-output') block.append(injectActions(event.text));
    }

    // Cross-highlight (§16.8): publish the block's on-screen span (so the terminal anchors a
    // marker to it) and let a double-click anywhere in it (nested findings included, via
    // bubbling) reveal those terminal rows. Manual captures carry no range, so they opt out.
    if (event.range) {
      publishRange(event);
      block.addEventListener('dblclick', () => {
        window.dispatchEvent(new CustomEvent(REVEAL_TERMINAL_EVENT, { detail: { id: event.id } }));
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
    chunkRegistry.delete(eventId);
    const timer = revealTimers.get(eventId);
    if (timer) {
      clearTimeout(timer);
      revealTimers.delete(eventId);
    }
    const el = elById(eventId);
    if (el) {
      unpublishRange(el); // also drops markers for any findings nested in a report (§16.8)
      el.remove();
    }
    refreshSelectionUI(); // a retracted chunk may have been checked
  }

  /** Scroll to + highlight the element with this id for REVEAL_HIGHLIGHT_MS; re-revealing
   *  restarts its timer (§16.8). The terminal pane already resolved the double-clicked row to
   *  the most-specific covering capture (pickRevealTarget), so here we just reveal that id; an
   *  id with no rendered element (already dismissed) is a no-op — best-effort provenance. */
  function revealById(id: string): void {
    const el = elById(id);
    if (!el) return;
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

  // Blocks toolbar (§16.2): bulk Add-to-todo (+ its undo slot), Dismiss selected, Dismiss
  // all. The pane owns it (§9.1, no terminal coupling). Add/Dismiss-selected stay disabled
  // until at least one chunk is checked.
  const toolbar = document.createElement('div');
  toolbar.className = 'blocks-toolbar';

  const addSelectedBtn = document.createElement('button');
  addSelectedBtn.id = 'add-selected-todo';
  addSelectedBtn.textContent = 'Add to todo';
  addSelectedBtn.disabled = true;
  addSelectedBtn.addEventListener('click', () => void onAddSelected());

  const undoSlot = document.createElement('span');
  undoSlot.className = 'add-undo-slot';

  const dismissSelectedBtn = document.createElement('button');
  dismissSelectedBtn.id = 'dismiss-selected';
  dismissSelectedBtn.textContent = 'Dismiss selected';
  dismissSelectedBtn.disabled = true;
  dismissSelectedBtn.addEventListener('click', () => {
    for (const { id } of checkedChunks()) {
      monitor.dismiss(id); // also drop from the store so replay won't resurrect it
      removeChunk(id);
    }
    refreshSelectionUI();
  });

  const dismissAll = document.createElement('button');
  dismissAll.id = 'dismiss-all';
  dismissAll.textContent = 'Dismiss all';
  dismissAll.addEventListener('click', () => {
    monitor.dismissAll();
    for (const el of blocksEl.querySelectorAll<HTMLElement>('[data-event-id]')) unpublishRange(el);
    blocksEl.innerHTML = '';
    rendered.clear();
    orphans.clear();
    chunkRegistry.clear();
    refreshSelectionUI();
  });

  toolbar.append(addSelectedBtn, undoSlot, dismissSelectedBtn, dismissAll);
  blocksEl.parentNode?.insertBefore(toolbar, blocksEl);

  return { appendBlock, removeBlock, revealById, renderCommands };
}
