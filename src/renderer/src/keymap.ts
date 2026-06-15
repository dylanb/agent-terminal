// Agent key bindings (§7.5.2): translate editor-style chords into the exact byte
// sequences Claude Code / readline expect, so the input box behaves like a normal
// editor (newline-without-submit, word motion, word delete) instead of submitting.
//
// The bytes ARE the contract:
//  - ESC+CR (`\x1b\r`) is the Meta+Enter "insert newline" form Claude Code reads.
//    xterm.js 5.5 has no kitty-keyboard protocol, so the CSI-u form (`\x1b[13;2u`)
//    would leak into the prompt as literal text — ESC+CR is the portable choice.
//  - meta-b / meta-f / ESC+DEL are the readline word forms understood by both bash
//    and Claude Code without any inputrc configuration.
// DOM events always report Option (macOS) as `altKey`, so one rule covers both.

export interface KeyEventLike {
  type: string;
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

/** The bytes to send for a chord, or `null` to let xterm handle the key normally. */
export function keyEventToBytes(e: KeyEventLike): string | null {
  if (e.type !== 'keydown') return null;

  // Shift+Enter / Alt+Enter: newline without submitting. Plain Enter (no modifier)
  // falls through to null so xterm sends bare CR and the line is submitted.
  if (e.key === 'Enter' && (e.shiftKey || e.altKey) && !e.ctrlKey && !e.metaKey) {
    return '\x1b\r';
  }

  if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
    switch (e.key) {
      case 'ArrowLeft':
        return '\x1bb';
      case 'ArrowRight':
        return '\x1bf';
      case 'Backspace':
        return '\x1b\x7f';
    }
  }

  return null;
}

/**
 * xterm `attachCustomKeyEventHandler` callback body: returns `true` to let xterm
 * process the key, `false` to suppress it after we've sent our own bytes. When we
 * handle a chord we also `preventDefault` so the hidden textarea doesn't double-edit.
 */
export function handleTerminalKey(
  e: KeyEventLike & { preventDefault?: () => void },
  send: (data: string) => void,
): boolean {
  const bytes = keyEventToBytes(e);
  if (bytes === null) return true;
  e.preventDefault?.();
  send(bytes);
  return false;
}
