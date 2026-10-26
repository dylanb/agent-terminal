// Terminal pane setup (§7.1): xterm + FitAddon, PTY wiring, debounced resize.

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { FOCUS_VIEW_EVENT } from './paneActions';
import { SEL_COLOR } from './selection';
import { stripPasteBreakout } from '../../shared/paste';
import { shellQuote } from '../../shared/shellQuote';

export const RESIZE_DEBOUNCE_MS = 80;

/** The terminal is view 1 in the converged shell (§22.4 / §24.1C). */
const TERMINAL_VIEW = '1';

/** The terminal pane organism: the xterm instance plus a `dispose()` that removes every window
 *  listener/timer it registered (UI-STANDARDS clean teardown), so it is safe to unmount/remount. */
export interface TerminalPane {
  terminal: Terminal;
  dispose(): void;
}

/** Wire the pane's window-level listeners — focus-on-view (§16.2/§22.4) and debounced resize
 *  (§7.1/§14) — and return a disposer that removes them and cancels any pending resize. Split out
 *  from xterm construction so the teardown is unit-testable without a real layout (the xterm bits
 *  need a real DOM; the e2e covers those). */
export function wireTerminalPaneListeners(opts: { focusView: () => void; resize: () => void }): () => void {
  const onFocusView = (e: Event): void => {
    if ((e as CustomEvent<{ view: string }>).detail?.view === TERMINAL_VIEW) opts.focusView();
  };
  window.addEventListener(FOCUS_VIEW_EVENT, onFocusView);

  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  const onResize = (): void => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(opts.resize, RESIZE_DEBOUNCE_MS);
  };
  window.addEventListener('resize', onResize);

  return () => {
    window.removeEventListener(FOCUS_VIEW_EVENT, onFocusView);
    window.removeEventListener('resize', onResize);
    if (resizeTimer) clearTimeout(resizeTimer);
  };
}

/** Single-quote each dropped path through the shared shell primitive and space-join them, so a path
 *  with spaces survives at the prompt; C0 control chars are stripped first so a CR/LF-bearing filename
 *  cannot submit a line through the paste seam (§7.8 "no submit") — the lossy sanitization the lossless
 *  shellQuote deliberately leaves to its callers. */
export function formatDroppedPaths(paths: string[]): string {
  return paths.map((p) => shellQuote(p.replace(/[\u0000-\u001f\u007f]/g, ''))).join(' ');
}

/** Wire file drag-and-drop on the terminal pane (§7.8): a drop pastes the dropped files' single-quoted
 *  paths via the §7.5/§9.3 sanitized paste seam (no submit). `pathForFile` resolves a `File` to its
 *  absolute path (preload `webUtils` bridge), returning `''` for a drag item with no path. */
export function wireTerminalDrop(
  container: HTMLElement,
  deps: { pathForFile: (file: File) => string; paste: (text: string) => void },
): () => void {
  let dragDepth = 0;
  const setOver = (on: boolean): void => void container.classList.toggle('drag-over', on);
  const onDragEnter = (e: DragEvent): void => {
    e.preventDefault();
    dragDepth += 1;
    setOver(true);
  };
  const onDragOver = (e: DragEvent): void => e.preventDefault();
  const onDragLeave = (): void => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) setOver(false);
  };
  const onDrop = (e: DragEvent): void => {
    e.preventDefault();
    dragDepth = 0;
    setOver(false);
    const paths = Array.from(e.dataTransfer?.files ?? [], (f) => deps.pathForFile(f)).filter((p) => p.length > 0);
    if (paths.length === 0) return;
    deps.paste(stripPasteBreakout(formatDroppedPaths(paths)));
  };
  container.addEventListener('dragenter', onDragEnter);
  container.addEventListener('dragover', onDragOver);
  container.addEventListener('dragleave', onDragLeave);
  container.addEventListener('drop', onDrop);
  return () => {
    container.removeEventListener('dragenter', onDragEnter);
    container.removeEventListener('dragover', onDragOver);
    container.removeEventListener('dragleave', onDragLeave);
    container.removeEventListener('drop', onDrop);
  };
}

/** The themed `--term-bg` for xterm's inline theme background; `undefined` when unset, leaving xterm's
 *  `#000` gutter default (§7.1/§7.4). */
export function readTermBg(container: HTMLElement): string | undefined {
  return (
    getComputedStyle(container).getPropertyValue('--term-bg').trim() ||
    getComputedStyle(document.documentElement).getPropertyValue('--term-bg').trim() ||
    undefined
  );
}

/** Re-seed xterm's inline theme background on each live `data-theme` toggle, else the gutter strip
 *  reappears one theme behind (the fill is that background and `--term-bg` differs per theme; §7.1/§7.4). */
export function wireTerminalThemeBackground(deps: {
  applyBg: (bg: string | undefined) => void;
  readBg: () => string | undefined;
}): () => void {
  const obs = new MutationObserver(() => deps.applyBg(deps.readBg()));
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => obs.disconnect();
}

export function createTerminalPane(container: HTMLElement): TerminalPane {
  const termBg = readTermBg(container);
  const term = new Terminal({
    fontFamily: 'monospace',
    fontSize: 14,
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: true,
    // Expose row content to assistive tech — the terminal is the primary surface (WCAG 4.1.2).
    screenReaderMode: true,
    theme: {
      background: termBg,
      // §7.0/§7.1: xterm's native selection is the only highlight, focused or not.
      selectionBackground: SEL_COLOR,
      selectionInactiveBackground: SEL_COLOR,
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(container);
  fit.fit();

  const offData = window.term.onData((data) => term.write(data));
  term.onData((data) => window.term.input(data));
  const offExit = window.term.onExit(({ code }) => term.write(`\r\n[process exited: ${code}]\r\n`));

  // Debounced resize: a drag-resize during an output burst can otherwise leave the PTY, renderer, and
  // shadow wrapping at different widths (§7.1/§14).
  const sendResize = (): void => {
    fit.fit();
    window.term.resize({ cols: term.cols, rows: term.rows });
  };
  // untestable under jsdom: the Send→reveal→focus loop needs a real layout (xterm focus) — verified in the
  // e2e; §12 gap tracked in #153.
  const unwire = wireTerminalPaneListeners({ focusView: () => term.focus(), resize: sendResize });
  const unwireDrop = wireTerminalDrop(container, {
    pathForFile: (file) => window.term.pathForFile(file),
    paste: (text) => term.paste(text),
  });
  const unwireThemeBg = wireTerminalThemeBackground({
    readBg: () => readTermBg(container),
    applyBg: (bg) => {
      term.options.theme = { ...term.options.theme, background: bg };
    },
  });
  sendResize();

  return {
    terminal: term,
    dispose() {
      offData();
      offExit();
      unwire();
      unwireDrop();
      unwireThemeBg();
      term.dispose();
    },
  };
}
