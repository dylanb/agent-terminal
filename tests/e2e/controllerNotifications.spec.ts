import { expect, test } from '@playwright/test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createControllerDesktopHarness } from './controllerDesktop';
import { autoGateFlowYaml, loopRoster, seedAutoGateRepo, seedTrustedFlow } from './autoGateHarness';
import { exampleConfigDir, seedFakeAgentV2, seedFakeGhGit } from './fakeTools';
import { exampleConsolidatorOutput } from '../../src/shared/consolidatorOutput';
import { shellQuote } from '../../src/shared/shellQuote';
import { controllerSnapshot } from './controllerSnapshot';
import { cardLocator, receivedNotificationLocator } from '../helpers/controllerCards';

const terminalTarget = { kind: 'development' as const, entry: resolve('out/main/index.js') };
const controllerTarget = { kind: 'development' as const, entry: resolve('out/main/controller.js') };

for (const scenario of ['focused', 'unfocused', 'absent', 'restarting'] as const) {
  const focused = scenario === 'focused';
  test(`controller notification at a real human gate: ${scenario}`, { tag: '@ownapp' }, async () => {
    test.setTimeout(240_000);
    const h = await createControllerDesktopHarness();
    const repo = seedAutoGateRepo('controller-attention-', 'red');
    const { binDir, logFile } = seedFakeGhGit('controller-attention-tools-', { realCommitOps: true });
    try {
      seedTrustedFlow(h.fixture.home, repo, 'attention-flow', autoGateFlowYaml([
        { id: 'red', kind: 'loop', loop: 'red-loop', authority: 'auto' }, { id: 'verify', kind: 'manual' },
      ], 'attention-flow'));
      const verdictHold = join(binDir, 'verdict-hold');
      writeFileSync(verdictHold, 'hold');
      seedFakeAgentV2(binDir, {
        holdConsolidate: { sentinel: verdictHold },
        stepId: 'red', artifactRel: '.agent-terminal/loop/artifacts/red-result.json', work: 'red',
        roster: loopRoster('red-loop'), verdicts: [exampleConsolidatorOutput('stop for a human', loopRoster('red-loop'))],
      });
      Object.assign(h.fixture.env, {
        PATH: `${binDir}:${process.env.PATH}`, FAKE_GHGIT_LOG: logFile, CLAUDE_CONFIG_DIR: exampleConfigDir,
        APP_SUBMIT_DELAY_MS: '100',
      });
      const controller = await h.launch(controllerTarget, h.fixture.nonGit);
      const terminal = await h.launch(terminalTarget, repo);
      await terminal.app.evaluate(({ Notification }) => {
        const probe = globalThis as typeof globalThis & { osNotifications: number };
        probe.osNotifications = 0;
        Notification.isSupported = () => true;
        Notification.prototype.show = () => { probe.osNotifications++; };
        Notification.prototype.close = () => {};
      });
      const screen = terminal.page.locator('.xterm-screen');
      await screen.click();
      await terminal.page.keyboard.type(`cd ${shellQuote(repo)}; fake-agent`);
      await terminal.page.keyboard.press('Enter');
      const control = terminal.page.locator('#flow-strip .flow-control');
      await expect(control).toHaveText('Start');
      await control.click();
      await expect.poll(() => existsSync(`${verdictHold}.pids`), { timeout: 60_000 }).toBe(true);
      if (scenario === 'absent' || scenario === 'restarting') await h.crash(controller.app);
      if (scenario === 'restarting') await h.launch(controllerTarget, h.fixture.nonGit);
      await terminal.app.evaluate(({ BrowserWindow }, focus) => {
        const window = BrowserWindow.getAllWindows()[0];
        if (focus) window.focus(); else window.blur();
      }, focused);
      await expect.poll(() => terminal.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused())).toBe(focused);
      const receiptLowerBound = Date.now();
      rmSync(verdictHold);
      const stateFile = join(repo, '.agent-terminal', 'loop', 'run-state.yaml');
      await expect.poll(() => { try { return readFileSync(stateFile, 'utf8'); } catch { return ''; } }, { timeout: 60_000 }).toContain('verdict: stop for a human');
      const source = await terminal.page.evaluate(directory => window.flow.state(directory), repo);
      expect(source.loop?.humanNeeded).toBe(true);
      if (scenario === 'focused' || scenario === 'unfocused') {
        const notification = receivedNotificationLocator(cardLocator(controller.page, repo));
        await expect.soft(notification).toContainText(source.loop!.status);
        await expect.soft.poll(async () => {
          const terminal = (await controllerSnapshot(controller.page)).find(item => item.launchDirectory === repo);
          const receivedAt = terminal?.notifications?.[0]?.receivedAt;
          return typeof receivedAt === 'number' && Number.isFinite(receivedAt)
            && receivedAt >= receiptLowerBound && receivedAt <= Date.now();
        }).toBe(true);
      }
      expect.soft(await terminal.app.evaluate(() => (globalThis as typeof globalThis & { osNotifications: number }).osNotifications)).toBe(0);
      expect.soft((await terminal.page.evaluate(directory => window.flow.state(directory), repo)).loop?.humanNeeded).toBe(true);
      expect.soft(await terminal.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused())).toBe(focused);
    } finally {
      try { await h.dispose(); }
      finally { rmSync(repo, { recursive: true, force: true }); rmSync(binDir, { recursive: true, force: true }); }
    }
  });
}
