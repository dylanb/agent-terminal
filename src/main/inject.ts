// Main-process injection API (§9.3) — the renderer-independent path used by the
// monitor pane. Mirrors term.paste()'s sanitization.

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/** Newlines→CR; strips ESC[201~ (paste-mode breakout guard); brackets iff the live mode is on. */
export function wrapForPaste(text: string, bracketed: boolean): string {
  const body = text.replace(/\r?\n/g, '\r').replace(/\x1b\[201~/g, '');
  return bracketed ? `${PASTE_START}${body}${PASTE_END}` : body;
}

// A setting, not a constant: a hardcoded 50 ms races on loaded machines and in CI (§14).
export const SUBMIT_DELAY_MS = Number(process.env.APP_SUBMIT_DELAY_MS) || 50;

export interface InjectorDeps {
  write(data: string): void;
  /** Read live at injection time — never cached (§9.3). */
  isBracketedPaste(): boolean;
  submitDelayMs?: number;
}

export type Injector = (text: string, opts?: { submit?: boolean }) => void;

export function createInjector(deps: InjectorDeps): Injector {
  const delay = deps.submitDelayMs ?? SUBMIT_DELAY_MS;
  return (text, { submit = false } = {}) => {
    if (!text) return;
    deps.write(wrapForPaste(text, deps.isBracketedPaste()));
    // The CR must land after the agent drains the paste, outside the markers (§9.3).
    if (submit) setTimeout(() => deps.write('\r'), delay);
  };
}
