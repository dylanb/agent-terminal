// Selection subsystem wiring (§7): gesture sourced from xterm, but the selection state is app-owned.

import type { IDecoration, IMarker, Terminal } from '@xterm/xterm';
import type { BufferType, SelectionRange } from '../../shared/ipc';
import { stripPasteBreakout } from '../../shared/paste';
import type { MonitorApi } from '../../shared/ipc';
import { cleanSelectionText, createSelectionModel } from './selectionModel';
import { createRepoContext, type RepoContext } from './repoContext';
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
 * Capture straight to the repo-scoped Todo list (§16.2): the selected text, else the latest
 * command's output. A no-op without a repo key or with nothing to capture. Signals the action
 * window (a separate pane, §9.1) to refresh after `todo:add` resolves — it can't see this add
 * otherwise, and the await ensures its re-pull sees the new item.
 */
export async function captureToTodo(
  monitor: MonitorApi,
  repoKey: string | null,
  selectionText: string | null,
): Promise<void> {
  if (!repoKey) return;
  // The detached `void captureToTodo(...)` call sites must never see a rejection (a main restart
  // can reject any of these invokes).
  try {
    if (selectionText !== null) {
      const text = cleanSelectionText(selectionText);
      if (!text) return; // empty-guard: never persist a blank todo (matches manual add / edit)
      await monitor.todoAdd(repoKey, text, { type: 'selection' });
    } else {
      const commands = await monitor.commands();
      const latest = commands[commands.length - 1]; // newest-last (§15.5)
      if (!latest) return;
      const cap = await monitor.captureCommandText(latest.id);
      if (!cap || !cap.text.trim()) return; // unknown/trimmed id, or empty output — nothing to add
      await monitor.todoAdd(repoKey, cap.text, { type: 'command-output' });
    }
    window.dispatchEvent(new CustomEvent(TODOS_CHANGED_EVENT));
  } catch {
    // IPC failure: leave the todo list unchanged and signal nothing.
  }
}

// >=3:1 against the #1e1e1e background (WCAG 1.4.11); the native highlight is suppressed (§7.0).
const SEL_COLOR = 'rgba(80, 140, 255, 0.7)';
// Cross-highlight reveal (§16.8) — amber, distinct from the blue selection so the two read apart.
const REVEAL_COLOR = 'rgba(255, 196, 84, 0.4)';

export function wireSelection(term: Terminal, repo: RepoContext = createRepoContext(window.monitor)): void {
  let decorations: IDecoration[] = [];
  const model = createSelectionModel(() => renderSelection());

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

  // TODO(dylan): the real xterm selection → captureToTodo path (and the no-selection
  // command-capture branch) is verified only in the §F e2e (plan PR5 5c) — jsdom can't
  // drive an xterm selection and the emulator must not be mocked (CLAUDE.md). Recorded gap.
  document.getElementById('capture-selection')!.addEventListener('click', () => {
    const s = model.get();
    const selectionText = s.active && s.start && s.end ? s.text : null;
    void captureToTodo(window.monitor, repo.repoKey(), selectionText);
  });

  document.getElementById('clear-selection')!.addEventListener('click', clearSelection);

  // ---- Cross-highlight between the terminal and the capture pane (§16.8) ----
  // Decoupled via the window-event bus (paneActions), so neither pane imports the other.
  //
  // The terminal owns the coordinates: a published span is anchored to xterm markers, which track
  // the buffer through scroll AND reflow, so a resize that re-wraps the transcript can't stale the
  // link (the §7.4 marker-anchoring guarantee). A marker trimmed out of scrollback disposes itself
  // → that capture reveals nothing (best-effort, §7.3).
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

  // Capture → terminal reveal: a separate decoration set from the selection's, so a clear of one
  // never wipes the other.
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

  // xterm allows a single custom key handler, so both key concerns share it. Escape clears only
  // when a selection is active; otherwise it belongs to the agent and must pass through (§7.5.1).
  // Everything else routes through the agent key bindings (§7.5.2).
  term.attachCustomKeyEventHandler((e) => {
    if (e.type === 'keydown' && e.key === 'Escape' && model.get().active) {
      clearSelection();
      return false;
    }
    return handleTerminalKey(e, (data) => window.term.input(data));
  });
}
