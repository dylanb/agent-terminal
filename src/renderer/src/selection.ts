// Selection subsystem wiring (§7): gesture sourced from xterm, but the selection state is app-owned.

import type { IMarker, Terminal } from '@xterm/xterm';
import type { BufferType, SelectionRange } from '../../shared/ipc';
import { stripPasteBreakout } from '../../shared/paste';
import type { MonitorApi } from '../../shared/ipc';
import { cleanSelectionText, createSelectionModel } from './selectionModel';
import { handleTerminalKey, type KeyActions } from './keymap';
import { resolveKeymap, type Keymap } from '../../shared/keymap';
import type { TerminalClipboard } from './menuActions';
import { pickRevealTarget, type RevealSpan } from './reveal';
import {
  CAPTURE_RANGE_ADD_EVENT,
  CAPTURE_RANGE_REMOVE_EVENT,
  REVEAL_CAPTURE_EVENT,
  REVEAL_HIGHLIGHT_MS,
  REVEAL_TERMINAL_EVENT,
  TODOS_CHANGED_EVENT,
} from './monitor';

/**
 * Capture `text` straight to the repo-scoped Todo list (§16.2). A no-op without a repo key or when
 * the text cleans to empty. Signals the action window (a separate pane, §9.1) to refresh after
 * `todo:add` resolves — it can't see this add otherwise, and the await ensures its re-pull sees the
 * new item.
 */
export async function captureToTodo(
  monitor: MonitorApi,
  repoKey: string | null,
  text: string,
): Promise<void> {
  if (!repoKey) return;
  const cleaned = cleanSelectionText(text);
  if (!cleaned) return; // empty-guard: never persist a blank todo (matches manual add / edit)
  // Callers invoke this fire-and-forget (e.g. the Artifacts add-to-todo sink), so a rejected
  // todo:add (a main restart can reject the invoke) is swallowed rather than surfaced.
  try {
    await monitor.todoAdd(repoKey, cleaned, { type: 'selection' });
    window.dispatchEvent(new CustomEvent(TODOS_CHANGED_EVENT));
  } catch {
    // IPC failure: leave the todo list unchanged and signal nothing.
  }
}

// >=3:1 against the #1e1e1e background (WCAG 1.4.11). §7.1
export const SEL_COLOR = 'rgba(80, 140, 255, 0.7)';
// Cross-highlight reveal (§16.8) — amber, distinct from the blue selection so a revealed
// capture span reads differently from a user selection.
const REVEAL_COLOR = 'rgba(255, 196, 84, 0.4)';

export function wireSelection(
  term: Terminal,
  getKeymap: () => Keymap = () => resolveKeymap(window.term.platform === 'darwin' ? 'mac' : 'pc'),
): TerminalClipboard {
  const model = createSelectionModel();

  function markerAtRow(absRow: number) {
    const buf = term.buffer.active;
    const cursorAbs = buf.baseY + buf.cursorY;
    return term.registerMarker(absRow - cursorAbs);
  }

  // xterm clears its own selection on typing, a click, and a buffer switch; the model follows so
  // Escape and Copy never act on a selection the user can no longer see (§7.5.1).
  term.onSelectionChange(() => {
    if (!term.hasSelection()) {
      model.clear();
      return;
    }
    let range, text: string;
    try {
      range = term.getSelectionPosition();
      text = term.getSelection();
    } catch {
      return; // alt-buffer / mid-swap edge cases must never crash the renderer (§7.3)
    }
    model.update({
      range,
      text,
      baseY: term.buffer.active.baseY,
      bufferType: term.buffer.active.type as BufferType,
    });
  });

  function clearSelection(): void {
    model.clear();
    term.clearSelection();
  }

  // ---- Cross-highlight between the terminal and the capture pane (§16.8) ----
  // Decoupled via the window-event bus (paneActions), so neither pane imports the other.
  //
  // The terminal owns the coordinates: a published span is anchored to xterm markers, which track
  // the buffer through scroll AND reflow, so a resize that re-wraps the transcript can't stale the
  // link (the §7.4 marker-anchoring guarantee). A marker trimmed out of scrollback disposes itself
  // → that capture reveals nothing (best-effort, §7.3).
  // untestable under jsdom: the marker layer (registerMarker/scrollToLine/reveal, getSelectionPosition) needs
  // a real terminal — verified in the e2e; §12 gap tracked in #153.
  const captureMarkers = new Map<string, { start: IMarker; end: IMarker }>();
  function disposeMarkers(id: string): void {
    const m = captureMarkers.get(id);
    if (!m) return;
    if (!m.start.isDisposed) m.start.dispose();
    if (!m.end.isDisposed) m.end.dispose();
    captureMarkers.delete(id);
  }
  window.addEventListener(CAPTURE_RANGE_ADD_EVENT, (e) => {
    const { id, range } = (e as CustomEvent<{ id: string; range: SelectionRange }>).detail;
    disposeMarkers(id); // a re-published span re-anchors
    const start = markerAtRow(range.start.y);
    const end = markerAtRow(range.end.y);
    if (!start || !end) return; // off-buffer / trimmed already — best-effort
    captureMarkers.set(id, { start, end });
  });
  window.addEventListener(CAPTURE_RANGE_REMOVE_EVENT, (e) => {
    disposeMarkers((e as CustomEvent<{ id: string }>).detail.id);
  });

  // Terminal → capture: resolve the double-clicked row to the capture that owns it. Key on a
  // capture-phase mouseup with detail === 2, NOT the synthesized dblclick: xterm's SelectionService
  // preventDefaults mousedown (which can suppress dblclick) and handles the gesture on the screen
  // element, so a bubbling dblclick may never reach us. Capture phase runs before xterm and is
  // immune to stopPropagation. xterm has word-selected by this mouseup, so getSelectionPosition()
  // holds the word's current absolute row.
  term.element?.addEventListener(
    'mouseup',
    (e) => {
      if ((e as MouseEvent).detail < 2) return; // single click — not a word/line select
      let pos;
      try {
        pos = term.getSelectionPosition();
      } catch {
        return; // alt-buffer / mid-swap edge cases must never crash the renderer (§7.3)
      }
      if (!pos) return;
      const spans: RevealSpan[] = [];
      for (const [id, { start, end }] of captureMarkers) {
        if (start.isDisposed || end.isDisposed) continue; // trimmed out of scrollback
        spans.push({ id, start: start.line, end: end.line });
      }
      const id = pickRevealTarget(spans, pos.start.y);
      if (id) window.dispatchEvent(new CustomEvent(REVEAL_CAPTURE_EVENT, { detail: { id } }));
    },
    true,
  );

  // Capture → terminal reveal (§16.8). A decoration's dispose leaves its marker registered with the
  // buffer, taxing every later line of output; disposing the marker takes its decoration with it.
  let revealMarkers: IMarker[] = [];
  let revealTimer: ReturnType<typeof setTimeout> | null = null;
  function clearReveal(): void {
    for (const marker of revealMarkers) marker.dispose();
    revealMarkers = [];
  }
  window.addEventListener(REVEAL_TERMINAL_EVENT, (e) => {
    const { id } = (e as CustomEvent<{ id: string }>).detail;
    const m = captureMarkers.get(id);
    if (!m || m.start.isDisposed || m.end.isDisposed) return; // gone / trimmed — reveal nothing
    clearReveal();
    if (revealTimer) clearTimeout(revealTimer);
    const startLine = m.start.line;
    const endLine = m.end.line;
    term.scrollToLine(startLine);
    for (let row = startLine; row <= endLine; row++) {
      const marker = markerAtRow(row);
      if (!marker) continue; // off-buffer / trimmed
      revealMarkers.push(marker);
      const deco = term.registerDecoration({ marker, x: 0, width: term.cols, height: 1 });
      if (!deco) continue; // undefined on the alt buffer (§7.4)
      deco.onRender((el) => {
        el.style.backgroundColor = REVEAL_COLOR;
        el.classList.add('reveal-highlight');
      });
    }
    revealTimer = setTimeout(clearReveal, REVEAL_HIGHLIGHT_MS);
  });

  // xterm allows a single custom key handler, so the two key concerns share it:
  // Escape clears only when a selection is active; otherwise it belongs to the
  // agent (interrupt in Claude Code) and must pass through (§7.5.1). Everything
  // else is routed through the agent key bindings (§7.5.2).
  // The active keymap (§7.7) is read live via getKeymap() so a profile switch takes effect with no
  // rewire. Copy uses the app-owned selection (§7), not xterm's hidden native one.
  const copy = (): void => {
    const s = model.get();
    if (s.active) window.term.clipboardWrite(cleanSelectionText(s.text));
  };
  // Paste through OUR path so the §9.3 breakout sanitization always runs (the browser/xterm native
  // paste would leak an embedded ESC[201~). term.paste() honors the foreground app's bracketed-paste
  // mode live (§7.5). preventDefault in the dispatch suppresses the browser's duplicate paste.
  const paste = (): void => {
    void window.term
      .clipboardRead()
      .then((text) => term.paste(stripPasteBreakout(text)))
      .catch(() => {}); // a rejected invoke (main restart) must not be an unhandled rejection
  };
  // Select-all feeds the app-owned model (§7) via the onSelectionChange listener above, so the
  // highlight and Copy both reflect the whole buffer with no extra sync.
  const selectAll = (): void => term.selectAll();

  const keyActions: KeyActions = { send: (data) => window.term.input(data), copy, paste, selectAll };
  term.attachCustomKeyEventHandler((e) => {
    if (e.type === 'keydown' && e.key === 'Escape' && model.get().active) {
      clearSelection();
      return false;
    }
    return handleTerminalKey(e, getKeymap(), keyActions);
  });

  // Exposed so the macOS Edit menu can drive the terminal's clipboard actions (§7.7).
  return { copy, paste, selectAll };
}
