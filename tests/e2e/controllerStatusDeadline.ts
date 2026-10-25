import type { Page } from '@playwright/test';

/** Observe all fields together; later assertions cannot give a slow field another deadline. */
export async function statusDeadline(page: Page, identity: string, patterns: RegExp[], start: 'now' | 'registration' = 'now') {
  const observation = await page.evaluateHandle(({ identity, patterns, start }) => {
    const checks = patterns.map(({ source, flags }) => new RegExp(source, flags));
    return { done: new Promise<{ matched: boolean[]; texts: string[] }>(resolve => {
      let began = start === 'now' ? performance.now() : undefined;
      const seen = checks.map(() => false);
      const texts: string[] = [];
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let registrationTimeout: ReturnType<typeof setTimeout> | undefined;
      let unsubscribe = () => {};
      const finish = () => { observer.disconnect(); unsubscribe(); clearTimeout(deadline); clearTimeout(registrationTimeout); resolve({ matched: seen, texts }); };
      const sample = () => {
        const pane = [...document.querySelectorAll('button')].find(button => button.textContent?.includes(identity));
        if (began === undefined) return;
        if (deadline === undefined) deadline = setTimeout(finish, Math.max(0, 2_000 - (performance.now() - began)));
        if (pane && performance.now() - began <= 2_000) {
          const text = pane.innerText;
          if (texts.at(-1) !== text) texts.push(text);
          checks.forEach((check, index) => { if (check.test(text)) seen[index] = true; });
        }
      };
      const observer = new MutationObserver(sample);
      observer.observe(document.body, { subtree: true, childList: true, characterData: true });
      // Registration itself is existing C2 setup, not an intended C3 failure.
      registrationTimeout = setTimeout(() => { if (began === undefined) { observer.disconnect(); unsubscribe(); resolve({ matched: [], texts }); } }, 15_000);
      if (start === 'registration') unsubscribe = window.controller.subscribeTerminals(terminals => {
        if (began === undefined && terminals.some(terminal => terminal.launchDirectory === identity && terminal.status !== 'disconnected')) began = performance.now();
        sample();
      });
      sample();
    }) };
  }, { identity, patterns: patterns.map(pattern => ({ source: pattern.source, flags: pattern.flags })), start });
  return async () => {
    try { return await observation.evaluate(value => value.done); }
    finally { await observation.dispose(); }
  };
}
