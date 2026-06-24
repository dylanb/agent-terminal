// Terminal pane setup (§7.1): xterm + FitAddon, PTY wiring, debounced resize.

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { FOCUS_VIEW_EVENT } from './paneActions';
import { SEL_COLOR } from './selection';

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
 *  need a real DOM; the §F e2e covers those). */
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

export function createTerminalPane(container: HTMLElement): TerminalPane {
  // xterm paints the viewport (scrollbar gutter included) with its inline theme background; left at
  // xterm's #000 default it mismatches the themed --term-bg pane as an ugly strip (§7.1/§7.4).
  const termBg =
    getComputedStyle(container).getPropertyValue('--term-bg').trim() ||
    getComputedStyle(document.documentElement).getPropertyValue('--term-bg').trim() ||
    undefined;
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
      // Focused selection paints live during the drag — xterm's hit-testing gives instant,
      // per-frame feedback the app-owned decoration can't (it churns faster than it paints, §7.1).
      selectionBackground: SEL_COLOR,
      // Blurred selection stays transparent: once focus leaves, the persistent app-owned
      // decoration (§7.0) is the sole highlight, so the two never double-tint off-focus.
      selectionInactiveBackground: 'rgba(0,0,0,0)',
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
  // TODO(dylan): the Send→reveal→focus loop through the real pane is verified in the §F e2e
  // (recorded gap — xterm focus needs a real layout, not jsdom); the listener teardown is unit-tested.
  const sendResize = (): void => {
    fit.fit();
    window.term.resize({ cols: term.cols, rows: term.rows });
  };
  const unwire = wireTerminalPaneListeners({ focusView: () => term.focus(), resize: sendResize });
  sendResize();

  return {
    terminal: term,
    dispose() {
      offData();
      offExit();
      unwire();
      term.dispose();
    },
  };
}
