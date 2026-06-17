// Capture tab (§24.1 mockup-exact / §15 / §16.2): captured reports/findings/command
// output rendered in the converged mockup's language — `.finding` cards with a title
// (.t), a muted meta line (.m), and subtle linkbtn actions (.a). All user text is set
// via textContent, never innerHTML, so captured bytes cannot inject markup. Reaches the
// Todo tab only through the narrow TodoSink (§16.2 Add to todo).
//
// Kept from the prior panel: the double-click → terminal row-range reveal (§16.8) and
// the retraction path (§15.3). Deferred to §24.2.1: Dismiss / Dismiss-all (§15.6) and
// the Add-to-todo Undo window (§16.2). Dropped: type badges, timestamps, command
// history, Mark-as-chrome.

import type { MonitorEvent, MonitorEventType, SelectionRange, TodoSourceType } from '../../shared/ipc';
import { doInject, REVEAL_HIGHLIGHT_MS, REVEAL_TERMINAL_EVENT } from './paneActions';
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
  /** Cross-highlight (§16.8): scroll to and highlight the card whose on-screen span
   *  covers `absRow` (the terminal row the user double-clicked); a no-op if none. */
  revealByRow(absRow: number): void;
}

export interface CaptureTabDeps {
  blocksEl: HTMLElement;
  todoSink: TodoSink;
}

export function createCaptureTab(deps: CaptureTabDeps): CaptureTab {
  const { blocksEl, todoSink } = deps;
  const rendered = new Set<string>();
  // Cross-highlight (§16.8): each card's on-screen span, and the live self-clearing
  // highlight timer per card (re-reveal resets it).
  const ranges = new Map<string, SelectionRange>();
  const revealTimers = new Map<string, ReturnType<typeof setTimeout>>();

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

    // Cross-highlight (§16.8): a card carries its on-screen span; double-clicking it
    // reveals exactly those terminal rows. Manual captures carry no range — they simply
    // don't participate. stopPropagation is unnecessary now that cards are flat (no nesting).
    if (event.range) {
      ranges.set(event.id, event.range);
      el.addEventListener('dblclick', () => {
        const range = ranges.get(event.id);
        if (range) window.dispatchEvent(new CustomEvent(REVEAL_TERMINAL_EVENT, { detail: { range } }));
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
  }

  /** Drop a card by id, clearing its dedup/range/timer bookkeeping. */
  function forget(id: string, el: HTMLElement | null): void {
    rendered.delete(id);
    ranges.delete(id);
    const timer = revealTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      revealTimers.delete(id);
    }
    el?.remove();
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

  /** Scroll to + highlight the card whose span covers `absRow` for REVEAL_HIGHLIGHT_MS;
   *  re-revealing restarts its timer (§16.8). When several cards cover the row, the
   *  **most specific** (smallest span) wins, so a finding highlights on its own. */
  function revealByRow(absRow: number): void {
    let bestId: string | null = null;
    let bestSpan = Infinity;
    for (const [id, range] of ranges) {
      if (absRow < range.start.y || absRow > range.end.y) continue;
      if (!elById(id)) {
        ranges.delete(id); // element gone but range lingered; self-heal
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

  return { appendBlock, removeBlock, revealByRow };
}
