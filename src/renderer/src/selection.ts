// Selection subsystem wiring (§7): gesture sourced from xterm, state app-owned,
// highlight drawn via per-line decorations, send/capture/clear actions.

import type { IDecoration, IMarker, Terminal } from '@xterm/xterm';
import type { BufferType, SelectionRange } from '../../shared/ipc';
import { stripPasteBreakout } from '../../shared/paste';
import type { MonitorApi } from '../../shared/ipc';
import { cleanSelectionText, createSelectionModel } from './selectionModel';
import { handleTerminalKey } from './keymap';
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
 * Capture straight to the repo-scoped Todo list (§16.2): the selected text when there is
 * a selection, otherwise the latest command's output (the only command-capture surface
 * now the per-entry button is gone). Then signal the action window — which owns the todo
 * count/list — to refresh, since it can't see this add otherwise (separate pane; §9.1).
 * Awaits `todo:add` before signalling so the re-pull sees the new item. Repo-scoped:
 * a no-op without a known repo key, or when there is nothing to capture.
 */
export async function captureToTodo(
  monitor: MonitorApi,
  repoKey: string | null,
  selectionText: string | null,
): Promise<void> {
  if (!repoKey) return;
  if (selectionText !== null) {
    await monitor.todoAdd(repoKey, cleanSelectionText(selectionText), { type: 'selection' });
  } else {
    const commands = await monitor.commands();
    const latest = commands[commands.length - 1]; // newest-last (§15.5)
    if (!latest) return;
    const cap = await monitor.captureCommandText(latest.id);
    if (!cap) return; // unknown/trimmed id — nothing to add
    await monitor.todoAdd(repoKey, cap.text, { type: 'command-output' });
  }
  window.dispatchEvent(new CustomEvent(TODOS_CHANGED_EVENT));
}

// >=3:1 against the #1e1e1e background (WCAG 1.4.11); the native highlight is suppressed (§7.0).
const SEL_COLOR = 'rgba(80, 140, 255, 0.7)';
// Cross-highlight reveal (§16.8) — amber, distinct from the blue selection so a revealed
// capture span reads differently from a user selection.
const REVEAL_COLOR = 'rgba(255, 196, 84, 0.4)';

export function wireSelection(term: Terminal): void {
  let decorations: IDecoration[] = [];
  const model = createSelectionModel(() => renderSelection());
  // Manual selection capture routes straight to the repo-scoped Todo list (§16.2);
  // track the live repo key the same way the action window does.
  let repoKey: string | null = null;
  window.monitor.onCwdChanged((m) => {
    repoKey = m.repoKey;
  });

  function clearDecorations(): void {
    for (const d of decorations) d.dispose();
    decorations = [];
  }

  function markerAtRow(absRow: number) {
    const buf = term.buffer.active;
    const cursorAbs = buf.baseY + buf.cursorY;
    return term.registerMarker(absRow - cursorAbs);
  }

  function renderSelection(): void {
    clearDecorations();
    const s = model.get();
    if (!s.active || !s.start || !s.end) return;

    for (let row = s.start.y; row <= s.end.y; row++) {
      const x = row === s.start.y ? s.start.x : 0;
      const xEnd = row === s.end.y ? s.end.x : term.cols;
      const width = Math.max(1, xEnd - x);

      const marker = markerAtRow(row);
      if (!marker) continue; // off-buffer / trimmed
      // One height-1 decoration per line — multi-row backgrounds render
      // incorrectly (xterm.js #4855); translucency must go on the element (§7.4).
      const deco = term.registerDecoration({ marker, x, width, height: 1 });
      if (!deco) continue; // undefined on the alt buffer (§7.4)
      deco.onRender((el) => {
        el.style.backgroundColor = SEL_COLOR;
      });
      decorations.push(deco);
    }
  }

  term.onSelectionChange(() => {
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

  term.onScroll(() => renderSelection());

  function clearSelection(): void {
    model.clear();
    term.clearSelection();
  }

  document.getElementById('send-selection')!.addEventListener('click', () => {
    const s = model.get();
    if (!s.active) return;
    // paste(), not write(): honors the foreground app's bracketed-paste mode (§7.5).
    // xterm's paste() does NOT strip the end marker, so we guard the breakout here (§7.5/§9.3).
    term.paste(stripPasteBreakout(cleanSelectionText(s.text)));
  });

  // Capture → Todo list (§16.2): selected text if any, else the latest command's output.
  // The routing (captureToTodo) is unit-tested; reading the live selection here is glue.
  // TODO(dylan): the real xterm selection → captureToTodo path (and the no-selection
  // command-capture branch) is verified only in the §F e2e (plan PR5 5c) — jsdom can't
  // drive an xterm selection and the emulator must not be mocked (CLAUDE.md). Recorded gap.
  document.getElementById('capture-selection')!.addEventListener('click', () => {
    const s = model.get();
    const selectionText = s.active && s.start && s.end ? s.text : null;
    void captureToTodo(window.monitor, repoKey, selectionText);
  });

  document.getElementById('clear-selection')!.addEventListener('click', clearSelection);

  // ---- Cross-highlight between the terminal and the capture pane (§16.8) ----
  // Decoupled via the window-event bus (paneActions), so neither pane imports the other.
  //
  // The terminal owns the coordinates. When the capture pane publishes a capture's span we
  // anchor **xterm markers** to its first/last rows; markers track the buffer through scroll
  // AND reflow, so a window resize that re-wraps the transcript can no longer stale the link
  // (this is the §7.4 marker-anchoring guarantee, now applied to provenance, not just the
  // highlight). Reveals are keyed by capture id; the marker's *current* `line` is read at
  // gesture time. A marker trimmed out of scrollback disposes itself → that capture simply
  // reveals nothing (best-effort, §7.3).
  //
  // TODO(dylan): the marker layer (registerMarker/`.line` after reflow, scrollToLine + reveal
  // decorations, getSelectionPosition on the double-click mouseup) needs a real terminal, so
  // it is verified only in the §F e2e ('capture ↔ terminal cross-highlight', incl. its resize
  // step), not under jsdom — recorded gap. The pure row→id matcher is unit-tested (reveal.ts).
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

  // Terminal → capture: resolve the double-clicked row to the capture that owns it (via the
  // markers' live lines) and name it to the pane. We key on a **capture-phase mouseup with
  // detail === 2**, NOT the synthesized `dblclick`: xterm's SelectionService calls
  // preventDefault on mousedown (which can suppress dblclick) and handles the gesture on the
  // screen element, so a bubbling dblclick may never reach us. Capture phase runs before xterm
  // and is immune to any stopPropagation; mouseup always fires. xterm has already word-selected
  // by this mouseup, so getSelectionPosition() holds the word's current absolute row.
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

  // Capture → terminal: read the capture's current marker rows, scroll them into view and draw
  // a self-clearing amber highlight over them, kept separate from the selection decorations so
  // a clear of one never wipes the other.
  let revealDecorations: IDecoration[] = [];
  let revealTimer: ReturnType<typeof setTimeout> | null = null;
  function clearReveal(): void {
    for (const d of revealDecorations) d.dispose();
    revealDecorations = [];
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
      const deco = term.registerDecoration({ marker, x: 0, width: term.cols, height: 1 });
      if (!deco) continue; // undefined on the alt buffer (§7.4)
      deco.onRender((el) => {
        el.style.backgroundColor = REVEAL_COLOR;
        el.classList.add('reveal-highlight');
      });
      revealDecorations.push(deco);
    }
    revealTimer = setTimeout(clearReveal, REVEAL_HIGHLIGHT_MS);
  });

  // xterm allows a single custom key handler, so the two key concerns share it:
  // Escape clears only when a selection is active; otherwise it belongs to the
  // agent (interrupt in Claude Code) and must pass through (§7.5.1). Everything
  // else is routed through the agent key bindings (§7.5.2).
  term.attachCustomKeyEventHandler((e) => {
    if (e.type === 'keydown' && e.key === 'Escape' && model.get().active) {
      clearSelection();
      return false;
    }
    return handleTerminalKey(e, (data) => window.term.input(data));
  });
}
