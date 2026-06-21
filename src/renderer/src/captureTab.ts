// Capture tab (§24.1 mockup-exact / §15 / §16.2 / §24.2.1): captured findings/command
// output rendered in the converged mockup's language — `.finding` cards with a title (.t),
// a muted meta line (.m), a per-card selection checkbox (.chunk-check), and subtle linkbtn
// actions (.a). All user text is set via textContent, never innerHTML, so captured bytes
// cannot inject markup. Reaches the Todo tab only through the narrow TodoSink (§16.2).
//
// Bulk triage (§24.2.1): each card carries a checkbox; a toolbar concatenates the checked
// chunks (appeared order, blank-line separated) into ONE todo with an Undo window + a
// processed-chunk cue, and offers Dismiss selected / Dismiss all. This supersedes the
// per-card "Add to todo" the mockup shipped, and subsumes Dismiss + Dismiss all.
//
// Report prose (§24.2.1): a report that carves no findings renders as an expandable summary
// card (`.report-prose` + <details>) so its body has a home without a dominating blob.
//
// Cross-highlight (§16.8, resize-safe): this pane deals only in capture **ids** — it
// publishes each ranged card's span (CAPTURE_RANGE_ADD/REMOVE) so the terminal can
// marker-anchor it, and reveals by id. The terminal owns the coordinates.

import type { MonitorApi, MonitorEvent, MonitorEventType, TodoItem } from '../../shared/ipc';
import {
  CAPTURE_RANGE_ADD_EVENT,
  CAPTURE_RANGE_REMOVE_EVENT,
  REVEAL_HIGHLIGHT_MS,
  REVEAL_TERMINAL_EVENT,
  TODO_UNDO_MS,
  type DoInject,
} from './paneActions';
import type { TodoSink } from './todoTab';

/** Muted meta-line label per type; unknown future types fall back to the raw type (§15.6). */
const TYPE_LABELS: Record<string, string> = {
  capture: 'capture',
  report: 'report',
  finding: 'finding',
  completion: 'completion',
  'command-output': 'command',
};

export interface CaptureTab {
  /** Render a stored event (replay or live); deduped by id so each renders once. */
  appendBlock(event: MonitorEvent): void;
  /** Show the latest manually-captured report single-slot (§21.1): clear the prior report's
   *  cards and render this one's findings (or the report prose if it carves none), preserving
   *  manual captures and command-output. `events` is [report, ...findings] from capture:last. */
  showReport(events: MonitorEvent[]): void;
  /** Drop a rendered card by id when main retracts it (superseded, §15.3). */
  removeBlock(eventId: string): void;
  /** Cross-highlight (§16.8): scroll to and border-highlight the capture with this id (the
   *  terminal pane resolved the double-clicked row to it); a no-op if it is no longer shown. */
  revealById(id: string): void;
}

export interface CaptureTabDeps {
  blocksEl: HTMLElement;
  todoSink: TodoSink;
  monitor: Pick<MonitorApi, 'dismiss' | 'dismissAll'>;
  /** Inject seam (§16.2 Insert at cursor) — injected, not reached from the window global. */
  doInject: DoInject;
}

export function createCaptureTab(deps: CaptureTabDeps): CaptureTab {
  const { blocksEl, todoSink, monitor, doInject } = deps;
  // Build all DOM from the host's document, never the ambient global — keeps the pane
  // relocatable to a separate-process window (UI-STANDARDS §3.3).
  const doc = blocksEl.ownerDocument;
  const rendered = new Set<string>();
  // Cross-highlight (§16.8): the live self-clearing reveal-highlight timer per element
  // (re-reveal resets it). The coordinates live on the terminal side, which marker-anchors
  // each span (so reflow can't stale it); this pane deals only in ids.
  const revealTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // Bulk triage (§16.2 / §24.2.1): each selectable card is a chunk. `seq` is render order =
  // appeared order so the bulk Add-to-todo concatenation reads oldest-first.
  let chunkSeq = 0;
  const chunkRegistry = new Map<string, { text: string; seq: number }>();
  let undoPending = false;
  // Chunks committed to the pending Add-to-todo: shown processed (dimmed + checkbox disabled)
  // until the undo window commits (then they're dismissed) or Undo reverts them.
  let processedIds: string[] = [];
  // The in-flight commit timer for the undo window — hoisted so endUndo() can cancel it (e.g. a
  // Dismiss all during the window must not leave a pending commit that fires against gone chunks).
  let undoTimer: ReturnType<typeof setTimeout> | null = null;

  /** Publish a capture's span so the terminal can marker-anchor it for cross-highlight (§16.8). */
  function publishRange(event: MonitorEvent): void {
    if (!event.range) return;
    window.dispatchEvent(new CustomEvent(CAPTURE_RANGE_ADD_EVENT, { detail: { id: event.id, range: event.range } }));
  }

  /** Ask the terminal to drop the marker for a removed card (§16.8). */
  function unpublishRange(el: HTMLElement): void {
    const id = el.dataset.eventId;
    if (id) window.dispatchEvent(new CustomEvent(CAPTURE_RANGE_REMOVE_EVENT, { detail: { id } }));
  }

  function badgeLabel(type: MonitorEventType): string {
    return TYPE_LABELS[type] ?? type;
  }

  function linkbtn(label: string, onClick: () => void): HTMLButtonElement {
    const b = doc.createElement('button');
    b.className = 'linkbtn';
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  /** A short label fragment of a capture's text so its checkbox/group are distinguishable. */
  function snippet(text: string): string {
    const oneLine = text.replace(/\s+/g, ' ').trim();
    return oneLine.length > 60 ? `${oneLine.slice(0, 57)}…` : oneLine;
  }

  function makeChunkCheckbox(eventId: string, text: string): HTMLInputElement {
    chunkRegistry.set(eventId, { text, seq: chunkSeq++ });
    const cb = doc.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'chunk-check';
    cb.dataset.chunkId = eventId;
    cb.setAttribute('aria-label', `Select for bulk action: ${snippet(text)}`);
    cb.addEventListener('change', refreshSelectionUI);
    return cb;
  }

  function dblclickReveal(el: HTMLElement, event: MonitorEvent): void {
    if (!event.range) return;
    el.addEventListener('dblclick', () => {
      window.dispatchEvent(new CustomEvent(REVEAL_TERMINAL_EVENT, { detail: { id: event.id } }));
    });
  }

  /** A report that carves no findings: an expandable summary card, prose tucked behind a
   *  <details> so it doesn't dominate the pane as a blob (§24.2.1). */
  function renderReportProse(event: MonitorEvent): HTMLElement {
    const el = doc.createElement('div');
    el.className = 'finding report-prose';
    el.dataset.eventId = event.id;
    el.dataset.type = event.type;
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', `Report: ${snippet(event.text)}`);
    dblclickReveal(el, event);

    const details = doc.createElement('details');
    const summary = doc.createElement('summary');
    summary.textContent = 'Report — no findings carved';
    const prose = doc.createElement('div');
    prose.className = 't prose';
    prose.textContent = event.text;
    details.append(summary, prose);

    el.append(makeChunkCheckbox(event.id, event.text), details);
    return el;
  }

  function renderCard(event: MonitorEvent): HTMLElement {
    if (event.type === 'report') return renderReportProse(event);

    const el = doc.createElement('div');
    el.className = 'finding';
    el.dataset.eventId = event.id;
    // Tag the source type so single-slot replace (showReport) clears only report/finding
    // cards, leaving manual captures and command-output in place (§21.1).
    el.dataset.type = event.type;
    if (event.parentId) el.dataset.parentId = event.parentId;
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', `${badgeLabel(event.type)}: ${snippet(event.text)}`);
    dblclickReveal(el, event);

    const t = doc.createElement('div');
    t.className = 't';
    t.textContent = event.text;

    const m = doc.createElement('div');
    m.className = 'm';
    m.textContent = badgeLabel(event.type) + (event.truncated ? ' · truncated' : '');

    el.append(makeChunkCheckbox(event.id, event.text), t, m);

    // command-output is the one inject-able capture (§16.2): Insert at cursor (no submit).
    if (event.type === 'command-output') {
      const a = doc.createElement('div');
      a.className = 'a';
      a.append(linkbtn('Insert at cursor', () => doInject(event.text, false)));
      el.append(a);
    }
    return el;
  }

  /** Any rendered event element by id (§16.8). */
  function elById(id: string): HTMLElement | null {
    for (const el of blocksEl.querySelectorAll<HTMLElement>('[data-event-id]')) {
      if (el.dataset.eventId === id) return el;
    }
    return null;
  }

  function appendBlock(event: MonitorEvent): void {
    // The pane shows actionable units only (§24.1 mockup): findings, manual/command
    // captures, completions. report blobs are carved into findings (so we render those, not
    // the blob — the prose fallback is reached only via showReport); tool-use / diff are
    // agent furniture that only carve report rows.
    if (event.type === 'report' || event.type === 'tool-use' || event.type === 'diff') return;
    if (rendered.has(event.id)) return;
    rendered.add(event.id);

    // Newest-first: prepend cards (§15.6 / v2.6).
    blocksEl.insertBefore(renderCard(event), blocksEl.firstChild);
    publishRange(event); // anchor the terminal's marker for this span (§16.8)
  }

  /** Manual single-slot capture (§21.1): replace the shown report. Clears prior report/finding
   *  cards (manual captures and command-output stay), then renders this report's findings in
   *  document order — or the report prose card when it carves none (§24.2.1). */
  function showReport(events: MonitorEvent[]): void {
    for (const el of [...blocksEl.querySelectorAll<HTMLElement>('.finding')]) {
      const t = el.dataset.type;
      if (t === 'report' || t === 'finding') forget(el.dataset.eventId ?? '', el);
    }
    const findings = events.filter((e) => e.type === 'finding');
    const toShow = findings.length > 0 ? findings : events.filter((e) => e.type === 'report');
    for (const event of toShow) {
      if (rendered.has(event.id)) continue;
      rendered.add(event.id);
      blocksEl.appendChild(renderCard(event)); // top-down order, not the newest-first append path
      publishRange(event);
    }
    refreshSelectionUI();
  }

  /** Drop a card by id, clearing dedup/timer/chunk bookkeeping and the terminal's marker. */
  function forget(id: string, el: HTMLElement | null): void {
    rendered.delete(id);
    chunkRegistry.delete(id);
    const timer = revealTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      revealTimers.delete(id);
    }
    if (el) {
      unpublishRange(el);
      el.remove();
    }
  }

  /**
   * Retraction (§15.3): the scanner superseded this event with a fuller capture, so drop
   * its card. A retracted report cascades to its findings — flat cards tagged with the
   * report's id — mirroring the old DOM-nested cascade.
   */
  function removeBlock(eventId: string): void {
    forget(eventId, elById(eventId));
    for (const el of [...blocksEl.querySelectorAll<HTMLElement>('[data-parent-id]')]) {
      if (el.dataset.parentId === eventId) forget(el.dataset.eventId!, el);
    }
    refreshSelectionUI();
  }

  /** Scroll to + highlight the element with this id for REVEAL_HIGHLIGHT_MS; re-revealing
   *  restarts its timer (§16.8). An id with no rendered element (already dropped) is a no-op. */
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

  // ---- Bulk triage (§16.2 / §24.2.1) ----

  function checkedChunks(): { id: string; text: string; seq: number }[] {
    return Array.from(blocksEl.querySelectorAll<HTMLInputElement>('.chunk-check'))
      .filter((c) => c.checked)
      .map((c) => ({ id: c.dataset.chunkId!, ...chunkRegistry.get(c.dataset.chunkId!)! }))
      .sort((a, b) => a.seq - b.seq);
  }

  function setProcessed(ids: string[], on: boolean): void {
    for (const id of ids) {
      const el = elById(id);
      if (!el) continue;
      el.classList.toggle('chunk-processed', on);
      const cb = el.querySelector<HTMLInputElement>('.chunk-check');
      if (cb) cb.disabled = on;
    }
  }

  function removeChunk(id: string): void {
    forget(id, elById(id));
  }

  function refreshSelectionUI(): void {
    const any = blocksEl.querySelector('.chunk-check:checked') !== null;
    addSelectedBtn.disabled = !any || undoPending;
    dismissSelectedBtn.disabled = !any;
  }

  // One undoable todo from all checked chunks (§16.2). The chunks are dismissed only when the
  // undo window elapses (commit); Undo deletes the just-added todo and leaves the chunks.
  async function onAddSelected(): Promise<void> {
    if (undoPending || !todoSink.currentRepoKey()) return;
    const selected = checkedChunks();
    if (selected.length === 0) return;
    const ids = selected.map((c) => c.id);
    undoPending = true;
    processedIds = ids;
    setProcessed(ids, true);
    refreshSelectionUI();
    // A rejected invoke (main restart) is treated the same as a silent failure below — never an
    // unhandled rejection, and the processed cue is cleared via endUndo().
    let added: TodoItem | null = null;
    try {
      added = await todoSink.addFromCapture(selected.map((c) => c.text).join('\n\n'), { type: 'capture' });
    } catch {
      added = null;
    }
    // The add failed (repo went away mid-flight, or IPC down): don't arm the commit, or the
    // source chunks would be dismissed with nothing added to the todo list.
    if (!added) {
      endUndo();
      return;
    }

    undoSlot.replaceChildren();
    const note = doc.createElement('span');
    note.className = 'added-note';
    note.textContent = 'Added to todo';
    const undo = doc.createElement('button');
    undo.className = 'undo-add-to-todo linkbtn';
    undo.textContent = 'Undo';
    undoTimer = setTimeout(() => {
      for (const id of ids) {
        monitor.dismiss(id);
        removeChunk(id);
      }
      endUndo();
    }, TODO_UNDO_MS);
    undo.addEventListener('click', async () => {
      if (undoTimer) { clearTimeout(undoTimer); undoTimer = null; } // stop the commit before awaiting
      try {
        if (added) await todoSink.deleteTodo(added.repoKey, added.id); // chunks stay; nothing dismissed
      } catch {
        // IPC failure (main restart): nothing dismissed; still end the window below.
      } finally {
        endUndo(); // always end the window, or processed chunks stay disabled forever
      }
    });
    undoSlot.append(note, undo);
  }

  function endUndo(): void {
    if (undoTimer) { clearTimeout(undoTimer); undoTimer = null; }
    undoPending = false;
    setProcessed(processedIds, false); // no-op for committed chunks (already removed)
    processedIds = [];
    undoSlot.replaceChildren();
    refreshSelectionUI();
  }

  // Toolbar (§16.2 / §24.2.1): bulk Add-to-todo (+ undo slot), Dismiss selected, Dismiss all.
  // Add/Dismiss-selected stay disabled until at least one chunk is checked.
  const toolbar = doc.createElement('div');
  toolbar.className = 'cap-toolbar';

  const addSelectedBtn = doc.createElement('button');
  addSelectedBtn.id = 'add-selected-todo';
  addSelectedBtn.className = 'pill sm signal';
  addSelectedBtn.textContent = 'Add to todo';
  addSelectedBtn.disabled = true;
  addSelectedBtn.addEventListener('click', () => void onAddSelected());

  const undoSlot = doc.createElement('span');
  undoSlot.className = 'add-undo-slot';

  const dismissSelectedBtn = doc.createElement('button');
  dismissSelectedBtn.id = 'dismiss-selected';
  dismissSelectedBtn.className = 'pill sm';
  dismissSelectedBtn.textContent = 'Dismiss selected';
  dismissSelectedBtn.disabled = true;
  dismissSelectedBtn.addEventListener('click', () => {
    for (const { id } of checkedChunks()) {
      monitor.dismiss(id); // also drop from the store so replay won't resurrect it
      removeChunk(id);
    }
    refreshSelectionUI();
  });

  const dismissAllBtn = doc.createElement('button');
  dismissAllBtn.id = 'dismiss-all';
  dismissAllBtn.className = 'pill sm';
  dismissAllBtn.textContent = 'Dismiss all';
  dismissAllBtn.addEventListener('click', () => {
    endUndo(); // a Dismiss all during the undo window must clear the stuck undo state + pending commit
    monitor.dismissAll();
    for (const el of blocksEl.querySelectorAll<HTMLElement>('[data-event-id]')) unpublishRange(el);
    blocksEl.replaceChildren();
    rendered.clear();
    chunkRegistry.clear();
    refreshSelectionUI();
  });

  toolbar.append(addSelectedBtn, undoSlot, dismissSelectedBtn, dismissAllBtn);
  blocksEl.parentNode?.insertBefore(toolbar, blocksEl);

  return { appendBlock, showReport, removeBlock, revealById };
}
