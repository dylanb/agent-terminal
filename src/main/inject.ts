// Main-process injection API (§9.3) — the renderer-independent path used by the
// monitor pane. Shares the paste-breakout guard with the renderer path (§7.5).

import { PASTE_END, PASTE_START, stripPasteBreakout } from '../shared/paste';

/** Newlines→CR; strips ESC[201~ (paste-mode breakout guard); brackets iff the live mode is on. */
export function wrapForPaste(text: string, bracketed: boolean): string {
  const body = stripPasteBreakout(text.replace(/\r?\n/g, '\r'));
  return bracketed ? `${PASTE_START}${body}${PASTE_END}` : body;
}

const DEFAULT_SUBMIT_DELAY_MS = 50;

/** Parse APP_SUBMIT_DELAY_MS; honors an explicit 0, falls back on unset/garbage/negative (§9.3). */
export function resolveSubmitDelay(
  raw: string | undefined,
  fallback = DEFAULT_SUBMIT_DELAY_MS,
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

// A setting, not a constant: a hardcoded 50 ms races on loaded machines and in CI (§14).
export const SUBMIT_DELAY_MS = resolveSubmitDelay(process.env.APP_SUBMIT_DELAY_MS);

// §B.20a — how long a deferred work turn waits for its skill injection to signal completion before the
// coordinator treats the injection as wedged and reverts the step (§D.4 deferred-turn row). The injector
// fires `onComplete` one macrotask after the submit delay, so the deadline is that delay plus a fixed grace
// — never a bare epsilon over the default, which would false-lapse the moment APP_SUBMIT_DELAY_MS is raised.
const DEFER_DEADLINE_GRACE_MS = 3_000;
export const DEFER_DEADLINE_MS = SUBMIT_DELAY_MS + DEFER_DEADLINE_GRACE_MS;

export interface InjectorDeps {
  write(data: string): void;
  /** Read live at injection time — never cached (§9.3). */
  isBracketedPaste(): boolean;
  submitDelayMs?: number;
  /** Seed the self-injection suppression signal at paste time, where the echo lands (§16.5). */
  onInject?(): void;
}

export type Injector = (
  text: string,
  opts?: { submit?: boolean; onComplete?: () => void },
) => void;

export function createInjector(deps: InjectorDeps): Injector {
  const delay = deps.submitDelayMs ?? SUBMIT_DELAY_MS;
  return (text, { submit = false, onComplete } = {}) => {
    if (!text) return;
    deps.write(wrapForPaste(text, deps.isBracketedPaste()));
    // Seed before the echo can return, so the watermark marks the pre-echo cursor row (§16.5).
    deps.onInject?.();
    // The CR must land after the agent drains the paste, outside the markers (§9.3). The completion
    // signal fires after that CR so a dispatch can chain causally off the injection (§B.13c), not off
    // a timer whose value the operator can raise past QUIET_MS.
    if (submit) {
      setTimeout(() => {
        deps.write('\r');
        onComplete?.();
      }, delay);
    }
  };
}
