import type { Page } from '@playwright/test';

export const STATUS_BUDGET_MS = 30_000;

export interface StatusObservationOptions {
  /** `registration` begins watching once the controller lists the terminal for `identity`. */
  start?: 'now' | 'registration';
  /** Keep watching at least this long after watching begins, so `ever` can also answer "never shown". */
  holdMs?: number;
}

export interface StatusObservation<K extends string> {
  /** Whether each named pattern matched the pane at some moment. */
  shown: Record<K, boolean>;
  /** Whether the pane ever contained `text` while it was watched. */
  ever(text: string | RegExp): boolean;
}

/** Watch the controller pane for `identity` until every named pattern has matched and the hold has passed. The
 *  returned function waits up to STATUS_BUDGET_MS for that and reports what was shown. Reading it is optional: an
 *  observation stops by itself once it is satisfied, and otherwise when its page closes. */
export async function observeStatus<K extends string>(page: Page, identity: string, patterns: Record<K, RegExp>, options: StatusObservationOptions = {}): Promise<() => Promise<StatusObservation<K>>> {
  const { start = 'now', holdMs = 0 } = options;
  const named = Object.entries<RegExp>(patterns).map(([name, pattern]) => ({ name, source: pattern.source, flags: pattern.flags }));
  const observation = await page.evaluateHandle(({ identity, named, start, holdMs }) => {
    const checks = named.map(({ source, flags }) => new RegExp(source, flags));
    let began = false;
    let held = holdMs === 0;
    const seen = checks.map(() => false);
    const texts: string[] = [];
    let unsubscribe = () => {};
    let resolveDone!: () => void;
    const done = new Promise<void>(resolve => { resolveDone = resolve; });
    const finish = () => { observer.disconnect(); unsubscribe(); unsubscribe = () => {}; resolveDone(); };
    const sample = () => {
      if (!began) return;
      const pane = [...document.querySelectorAll('button')].find(button => button.textContent?.includes(identity));
      if (pane) {
        const text = pane.innerText;
        if (texts.at(-1) !== text) texts.push(text);
        checks.forEach((check, index) => { if (check.test(text)) seen[index] = true; });
      }
      if (held && seen.every(Boolean)) finish();
    };
    const begin = () => {
      began = true;
      if (!held) setTimeout(() => { held = true; sample(); }, holdMs);
    };
    const observer = new MutationObserver(sample);
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    if (start === 'now') begin();
    else unsubscribe = window.controller.subscribeTerminals(terminals => {
      if (!began && terminals.some(terminal => terminal.launchDirectory === identity && terminal.status !== 'disconnected')) begin();
      sample();
    });
    sample();
    return { done, finish, result: () => ({ seen: [...seen], texts: [...texts] }) };
  }, { identity, named, start, holdMs });
  return async () => {
    try {
      const { seen, texts } = await observation.evaluate(async (value, budget) => {
        await Promise.race([value.done, new Promise(resolve => setTimeout(resolve, budget))]);
        value.finish();
        return value.result();
      }, STATUS_BUDGET_MS);
      return {
        shown: Object.fromEntries(named.map(({ name }, index) => [name, seen[index]])) as Record<K, boolean>,
        ever: text => texts.some(seenText => (typeof text === 'string' ? seenText.includes(text) : text.test(seenText))),
      };
    } finally { await observation.dispose(); }
  };
}
