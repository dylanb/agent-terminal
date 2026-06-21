// Renderer-side terminal key dispatch (§7.7): resolve a DOM key event against the active keymap and
// run the action. Motions emit byte sequences (the bytes ARE the contract — see src/shared/keymap.ts);
// clipboard actions are injected side effects so this stays the single, testable dispatch seam.
// An unbound key (matchChord → null) passes through to xterm/PTY untouched — that is how Ctrl+C
// stays SIGINT and plain Enter stays submit.

import { matchChord, BYTES_FOR, type Keymap, type KeyEventLike } from '../../shared/keymap';

export type { KeyEventLike } from '../../shared/keymap';

/** Side effects the dispatch invokes for non-byte actions. `paste`/`selectAll` are optional so a
 *  slice can wire `copy` before the rest; an unwired action simply passes through. */
export interface KeyActions {
  send(data: string): void;
  copy(): void;
  paste?(): void;
  selectAll?(): void;
}

/**
 * xterm `attachCustomKeyEventHandler` body: returns `true` to let xterm process the key, `false`
 * once we've handled it ourselves (and we `preventDefault` so the hidden textarea doesn't double-edit).
 */
export function handleTerminalKey(
  e: KeyEventLike & { preventDefault?: () => void },
  keymap: Keymap,
  actions: KeyActions,
): boolean {
  const action = matchChord(e, keymap);
  if (action === null) return true;

  const bytes = BYTES_FOR[action];
  if (bytes !== undefined) {
    e.preventDefault?.();
    actions.send(bytes);
    return false;
  }
  const effect =
    action === 'copy' ? actions.copy : action === 'paste' ? actions.paste : action === 'selectAll' ? actions.selectAll : undefined;
  if (!effect) return true; // resolved to an action not wired here yet: leave it to xterm/PTY
  e.preventDefault?.();
  effect();
  return false;
}
