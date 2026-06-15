// Selection subsystem wiring (§7): gesture sourced from xterm, state app-owned,
// highlight drawn via per-line decorations, send/capture/clear actions.

import type { IDecoration, Terminal } from '@xterm/xterm';
import type { BufferType } from '../../shared/ipc';
import { stripPasteBreakout } from '../../shared/paste';
import type { MonitorApi } from '../../shared/ipc';
import { cleanSelectionText, createSelectionModel } from './selectionModel';
import { handleTerminalKey } from './keymap';
import { TODOS_CHANGED_EVENT } from './monitor';

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
