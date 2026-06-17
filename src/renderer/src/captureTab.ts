// Capture tab (§24.1 mockup-exact / §15 / §16.2): captured findings/command output
// rendered in the converged mockup's language — `.finding` cards with a title (.t), a
// muted meta line (.m), and subtle linkbtn actions (.a). All user text is set via
// textContent, never innerHTML, so captured bytes cannot inject markup. Reaches the
// Todo tab only through the narrow TodoSink (§16.2 Add to todo).
//
// Cross-highlight (§16.8, resize-safe): this pane deals only in capture **ids** — it
// publishes each ranged card's span (CAPTURE_RANGE_ADD/REMOVE) so the terminal can
// marker-anchor it (markers track reflow, so a resize can't stale the link), and reveals
// by id. The terminal owns the coordinates and resolves a double-clicked row to an id.
//
// Deferred to §24.2.1: Dismiss / Dismiss-all (§15.6) and the Add-to-todo Undo (§16.2).
// Dropped: type badges, timestamps, command history, Mark-as-chrome. Report blobs are
// carved into findings (we render those, not the blob).

import type { MonitorEvent, MonitorEventType, TodoSourceType } from '../../shared/ipc';
import {
  CAPTURE_RANGE_ADD_EVENT,
  CAPTURE_RANGE_REMOVE_EVENT,
  doInject,
  REVEAL_HIGHLIGHT_MS,
  REVEAL_TERMINAL_EVENT,
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
  /** Drop a rendered card by id when main retracts it (superseded, §15.3). */
  removeBlock(eventId: string): void;
  /** Cross-highlight (§16.8): scroll to and border-highlight the capture with this id (the
   *  terminal pane resolved the double-clicked row to it); a no-op if it is no longer shown. */
  revealById(id: string): void;
}

export interface CaptureTabDeps {
  blocksEl: HTMLElement;
  todoSink: TodoSink;
}

export function createCaptureTab(deps: CaptureTabDeps): CaptureTab {
  const { blocksEl, todoSink } = deps;
  const rendered = new Set<string>();
  // Cross-highlight (§16.8): the live self-clearing reveal-highlight timer per element
  // (re-reveal resets it). The coordinates live on the terminal side, which marker-anchors
  // each span (so reflow can't stale it); this pane deals only in ids.
  const revealTimers = new Map<string, ReturnType<typeof setTimeout>>();

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
    const b = document.createElement('button');
    b.className = 'linkbtn';
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  /** Add to todo (§16.2): post the capture, then confirm in place. Undo is deferred (§24.2.1). */
  function addToTodoButton(event: MonitorEvent): HTMLButtonElement {
    const add = linkbtn('Add to todo', async () => {
      if (!todoSink.currentRepoKey()) return;
      const item = await todoSink.addFromCapture(event.text, {
        type: sourceTypeFor(event.type),
        eventId: event.id,
      });
      if (item) {
        add.textContent = 'Added ✓';
        add.disabled = true;
      }
    });
    add.classList.add('add-to-todo');
    return add;
  }

  function renderCard(event: MonitorEvent): HTMLElement {
    const el = document.createElement('div');
    el.className = 'finding';
    el.dataset.eventId = event.id;
    // Parent report id (§15.3): a report retraction must cascade to its findings, which
    // are flat top-level cards here (not DOM-nested), so removal is by this tag.
    if (event.parentId) el.dataset.parentId = event.parentId;
    el.setAttribute('role', 'group');

    // Cross-highlight (§16.8): double-clicking a ranged card asks the terminal to reveal
    // its rows; the terminal reads the card's live marker rows. Manual captures (no range)
    // don't participate.
    if (event.range) {
      el.addEventListener('dblclick', () => {
        window.dispatchEvent(new CustomEvent(REVEAL_TERMINAL_EVENT, { detail: { id: event.id } }));
      });
    }

    const t = document.createElement('div');
    t.className = 't';
    t.textContent = event.text;

    const m = document.createElement('div');
    m.className = 'm';
    m.textContent = badgeLabel(event.type) + (event.truncated ? ' · truncated' : '');

    const a = document.createElement('div');
    a.className = 'a';
    // command-output is the one inject-able capture (§16.2): Insert at cursor (no submit).
    if (event.type === 'command-output') a.append(linkbtn('Insert at cursor', () => doInject(event.text, false)));
    a.append(addToTodoButton(event));

    el.append(t, m, a);
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
    // captures, completions. report blobs are carved into findings (so we render those,
    // not the blob); tool-use / diff are agent furniture that only carve report rows.
    if (event.type === 'report' || event.type === 'tool-use' || event.type === 'diff') return;
    // Replay (§8.4) and the live stream can both deliver the same id; render once.
    if (rendered.has(event.id)) return;
    rendered.add(event.id);

    // Newest-first: prepend cards (§15.6 / v2.6).
    blocksEl.insertBefore(renderCard(event), blocksEl.firstChild);
    publishRange(event); // anchor the terminal's marker for this span (§16.8)
  }

  /** Drop a card by id, clearing dedup/timer bookkeeping and the terminal's marker. */
  function forget(id: string, el: HTMLElement | null): void {
    rendered.delete(id);
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
   * report's id — mirroring the old DOM-nested cascade; bookkeeping is cleared so no
   * stale id lingers.
   */
  function removeBlock(eventId: string): void {
    forget(eventId, elById(eventId));
    for (const el of [...blocksEl.querySelectorAll<HTMLElement>('[data-parent-id]')]) {
      if (el.dataset.parentId === eventId) forget(el.dataset.eventId!, el);
    }
  }

  /** Scroll to + highlight the element with this id for REVEAL_HIGHLIGHT_MS; re-revealing
   *  restarts its timer (§16.8). The terminal pane already resolved the double-clicked row to
   *  the most-specific covering capture (pickRevealTarget), so here we just reveal that id; an
   *  id with no rendered element (already dropped) is a no-op — best-effort provenance. */
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

  return { appendBlock, removeBlock, revealById };
}
