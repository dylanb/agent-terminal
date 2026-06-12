// Selection subsystem wiring (§7): gesture sourced from xterm, state app-owned,
// highlight drawn via per-line decorations, send/capture/clear actions.

import type { IDecoration, Terminal } from '@xterm/xterm';
import type { BufferType } from '../../shared/ipc';
import { cleanSelectionText, createSelectionModel } from './selectionModel';

const SEL_COLOR = 'rgba(80, 140, 255, 0.35)';

export function wireSelection(term: Terminal): void {
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
    term.paste(cleanSelectionText(s.text));
  });

  document.getElementById('capture-selection')!.addEventListener('click', () => {
    const s = model.get();
    if (!s.active || !s.start || !s.end) return;
    window.monitor.capture({
      text: cleanSelectionText(s.text),
      range: { start: s.start, end: s.end, baseY: s.baseY, bufferType: s.bufferType },
      source: 'selection',
    });
  });

  document.getElementById('clear-selection')!.addEventListener('click', clearSelection);

  // Escape clears only when a selection is active; otherwise it belongs to the
  // agent (interrupt in Claude Code) and must pass through (§7.5.1).
  term.attachCustomKeyEventHandler((e) => {
    if (e.type === 'keydown' && e.key === 'Escape' && model.get().active) {
      clearSelection();
      return false;
    }
    return true;
  });
}
