// macOS Edit-menu router (§7.7): the main-process Edit menu (src/main/appMenu.ts) routes Copy/Paste/
// Select All here so the TERMINAL uses our app-owned selection (§7) and §9.3-sanitized paste, while a
// focused text input keeps native editing (⌘C/⌘V/⌘A require menu involvement on macOS). Only mounted
// on macOS; off darwin the renderer keymap (§7.5) owns the chords and this never fires.

import type { EditAction } from '../../shared/ipc';

export interface TerminalClipboard {
  copy(): void;
  paste(): void;
  selectAll(): void;
}

export function runMenuEditAction(
  action: EditAction,
  doc: Document,
  term: TerminalClipboard,
  clipboardRead: () => Promise<string>,
): void {
  const el = doc.activeElement as HTMLElement | null;
  // Terminal surface = the xterm helper textarea (or nothing focused, our primary surface). A real
  // text input/contenteditable elsewhere falls through to native editing.
  const inTerminal =
    !el || el === doc.body || el.classList.contains('xterm-helper-textarea') || el.closest('#terminal') !== null;
  if (inTerminal) {
    term[action]();
    return;
  }
  if (action === 'copy') doc.execCommand('copy');
  else if (action === 'selectAll') doc.execCommand('selectAll');
  else void clipboardRead().then((t) => doc.execCommand('insertText', false, t)).catch(() => {});
}
