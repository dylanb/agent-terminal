import type { Page } from '@playwright/test';

export const STATUS_BUDGET_MS = 30_000;

/** Observe all fields together until each has matched and `holdMs` has passed since observation began, or until
 *  the budget runs out once the result is awaited. `holdMs` keeps recording texts for an absence check. */
export async function observeStatus(page: Page, identity: string, patterns: RegExp[], start: 'now' | 'registration' = 'now', holdMs = 0) {
  const observation = await page.evaluateHandle(({ identity, patterns, start, holdMs }) => {
    const checks = patterns.map(({ source, flags }) => new RegExp(source, flags));
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
    return { done, finish, result: () => ({ matched: [...seen], texts: [...texts] }) };
  }, { identity, patterns: patterns.map(pattern => ({ source: pattern.source, flags: pattern.flags })), start, holdMs });
  return async () => {
    try {
      return await observation.evaluate(async (value, budget) => {
        await Promise.race([value.done, new Promise(resolve => setTimeout(resolve, budget))]);
        value.finish();
        return value.result();
      }, STATUS_BUDGET_MS);
    } finally { await observation.dispose(); }
  };
}
