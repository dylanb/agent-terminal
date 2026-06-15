// Terminal pane setup (§7.1): xterm + FitAddon, PTY wiring, debounced resize.
// Native selection highlight is transparent — the app draws its own (§7.0).

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { FOCUS_TERMINAL_EVENT } from './monitor';

export const RESIZE_DEBOUNCE_MS = 80;

export function createTerminalPane(container: HTMLElement): Terminal {
  const term = new Terminal({
    fontFamily: 'monospace',
    fontSize: 14,
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: true,
    // Expose row content to assistive tech — the terminal is the primary surface (WCAG 4.1.2).
    screenReaderMode: true,
    theme: {
      selectionBackground: 'rgba(0,0,0,0)',
      selectionInactiveBackground: 'rgba(0,0,0,0)',
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(container);
  fit.fit();

  window.term.onData((data) => term.write(data));
  term.onData((data) => window.term.input(data));
  window.term.onExit(({ code }) => term.write(`\r\n[process exited: ${code}]\r\n`));

  // §16.2 focus rule: the action window asks (via a decoupled window event, never an
  // import) for terminal focus after an Insert, so the user can finish/submit here.
  // TODO(dylan): the Insert→focus loop through the real pane is verified in the §F
  // e2e (plan PR5 5c) — recorded gap (xterm needs a real layout, not jsdom).
  window.addEventListener(FOCUS_TERMINAL_EVENT, () => term.focus());

  // Debounced: a drag-resize during an output burst can otherwise leave the PTY,
  // renderer, and shadow wrapping at different widths (§7.1/§14).
  const sendResize = (): void => {
    fit.fit();
    window.term.resize({ cols: term.cols, rows: term.rows });
  };
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  window.addEventListener('resize', () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(sendResize, RESIZE_DEBOUNCE_MS);
  });
  sendResize();

  return term;
}
