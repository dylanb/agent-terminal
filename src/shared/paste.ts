// Bracketed-paste fence bytes and the paste-breakout guard (§7.5/§9.3). An embedded end marker
// terminates the fence early, delivering the remainder as live keystrokes — strip on every
// injection path before wrapping.

export const PASTE_START = '\x1b[200~';
export const PASTE_END = '\x1b[201~';

/** Remove every embedded paste-end marker so content cannot break out of paste mode. */
export function stripPasteBreakout(text: string): string {
  return text.split(PASTE_END).join('');
}
