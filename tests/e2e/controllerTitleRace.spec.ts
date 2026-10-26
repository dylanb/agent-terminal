import { expect, test } from '@playwright/test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createControllerDesktopHarness } from './controllerDesktop';
import { seedTrustedFlow } from './autoGateHarness';
import { STATUS_BUDGET_MS } from './controllerStatusObservation';
import { shellQuote } from '../../src/shared/shellQuote';

const terminalTarget = { kind: 'development' as const, entry: resolve('out/main/index.js') };
const controllerTarget = { kind: 'development' as const, entry: resolve('out/main/controller.js') };
const LATE_RENDER_WINDOW_MS = 10_000;

for (const returnToFirstRepo of [false, true]) {
  test(`late issue title cannot relabel current work after ${returnToFirstRepo ? 'A to B to A' : 'A to B'}`, { tag: '@ownapp' }, async () => {
    test.setTimeout(180_000);
    const h = await createControllerDesktopHarness();
    const [a, b] = h.fixture.repositories;
    try {
      for (const [index, repo] of [a, b].entries()) {
        mkdirSync(join(repo, '.agent-terminal'), { recursive: true });
        seedTrustedFlow(h.fixture.home, repo, `titles-${index}`, `name: titles-${index}\nsteps:\n  - id: implement\n    kind: manual\n    inputs:\n      - name: ticket\n        type: github-ticket\n`);
        writeFileSync(join(repo, '.agent-terminal', 'flow-state.yaml'), `step: implement\nstatus: not_started\ninputs:\n  ticket: "${219 + index}"\n`);
      }
      Object.assign(h.fixture.env, {
        PATH: `${join(h.fixture.root, 'bin')}:${process.env.PATH}`,
        TITLE_NEW_OCCURRENCE: join(h.fixture.root, 'title-new-occurrence'),
        TITLE_ALLOW: join(h.fixture.root, 'title-allow'), TITLE_STARTED: join(h.fixture.root, 'title-started'), TITLE_RELEASED: join(h.fixture.root, 'title-released'),
      });
      writeFileSync(join(h.fixture.root, 'bin', 'gh'), `#!/bin/sh
if [ "$1" = issue ] && [ "$3" = 219 ] && [ ! -e "$TITLE_NEW_OCCURRENCE" ]; then
  touch "$TITLE_STARTED"
  while [ ! -e "$TITLE_ALLOW" ]; do sleep 0.02; done
  printf '%s\\n' '{"title":"OBSOLETE_TITLE_219","body":"PRIVATE BODY","url":"https://github.com/example/repo/issues/219"}'
  touch "$TITLE_RELEASED"
else
  printf '{"title":"CURRENT_TITLE_%s","body":"PRIVATE BODY","url":"https://github.com/example/repo/issues/%s"}\\n' "$3" "$3"
fi
`, { mode: 0o700 });
      const controller = await h.launch(controllerTarget, h.fixture.nonGit);
      const terminal = await h.launch(terminalTarget, a);
      const control = terminal.page.locator('#flow-strip .flow-control');
      await expect(control).toHaveText('Start');
      await control.click();
      await expect.poll(() => existsSync(h.fixture.env.TITLE_STARTED)).toBe(true);
      await terminal.page.locator('.xterm-screen').click();
      await terminal.page.keyboard.type(`cd ${shellQuote(b)}`);
      await terminal.page.keyboard.press('Enter');
      await expect(control).toHaveText('Start');
      await control.click();
      await expect(control).toHaveText('Advance');
      let currentIssue = 220;
      if (returnToFirstRepo) {
        writeFileSync(h.fixture.env.TITLE_NEW_OCCURRENCE, 'new occurrence');
        await terminal.page.locator('.xterm-screen').click();
        await terminal.page.keyboard.type(`cd ${shellQuote(a)}`);
        await terminal.page.keyboard.press('Enter');
        currentIssue = 219;
      }
      await expect(terminal.page.locator('#status-bar')).toContainText(new RegExp(`(?:#|CURRENT_TITLE_)${currentIssue}`));
      const pane = controller.page.getByRole('button', { name: a, exact: false });
      await expect.soft(pane).toContainText(`CURRENT_TITLE_${currentIssue}`, { timeout: STATUS_BUDGET_MS });
      expect(existsSync(h.fixture.env.TITLE_RELEASED)).toBe(false);
      const observation = await controller.page.evaluateHandle(() => {
        const texts = [document.body.innerText];
        const observer = new MutationObserver(() => texts.push(document.body.innerText));
        observer.observe(document.body, { subtree: true, childList: true, characterData: true });
        return { stopAfter: (duration: number) => new Promise<string[]>(resolve => setTimeout(() => { observer.disconnect(); resolve(texts); }, duration)) };
      });
      writeFileSync(h.fixture.env.TITLE_ALLOW, 'release');
      await expect.poll(() => existsSync(h.fixture.env.TITLE_RELEASED)).toBe(true);
      const observed = await observation.evaluate((value, duration) => value.stopAfter(duration), LATE_RENDER_WINDOW_MS);
      await expect.soft(pane).toContainText(`#${currentIssue}`, { timeout: STATUS_BUDGET_MS });
      await expect.soft(pane).toContainText(`CURRENT_TITLE_${currentIssue}`, { timeout: STATUS_BUDGET_MS });
      await observation.dispose();
      expect.soft(observed.every(text => !text.includes('OBSOLETE_TITLE_219') && !text.includes('PRIVATE BODY'))).toBe(true);
      await expect.soft(pane).toContainText(a);
      await expect.soft(controller.page.getByRole('button', { name: b, exact: false })).toHaveCount(0);
    } finally {
      if (h.fixture.env.TITLE_ALLOW) writeFileSync(h.fixture.env.TITLE_ALLOW, 'release during cleanup');
      await h.dispose();
    }
  });
}
