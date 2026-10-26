import { expect, test } from '@playwright/test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createControllerDesktopHarness } from './controllerDesktop';
import { statusDeadline } from './controllerStatusDeadline';
import { autoGateFlowYaml, loopRoster, seedAutoGateRepo, seedTrustedFlow } from './autoGateHarness';
import { exampleConfigDir, seedFakeAgentV2, seedFakeGhGit } from './fakeTools';
import { exampleConsolidatorOutput } from '../../src/shared/consolidatorOutput';
import { shellQuote } from '../../src/shared/shellQuote';
import { bringForwardLocator, cardLocator } from '../helpers/controllerCards';

const terminalTarget = { kind: 'development' as const, entry: resolve('out/main/index.js') };
const controllerTarget = { kind: 'development' as const, entry: resolve('out/main/controller.js') };
const DISPLAY_BOUND_MS = 2_000;

for (const action of ['click', 'keyboard', 'resolve'] as const) {
  test(`real human gate ${action} preserves attention until terminal resolution`, { tag: '@ownapp' }, async () => {
    test.setTimeout(120_000);
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
      const screen = terminal.page.locator('.xterm-screen');
      await screen.click();
      await terminal.page.keyboard.type(`cd ${shellQuote(repo)}; fake-agent`);
      await terminal.page.keyboard.press('Enter');
      const control = terminal.page.locator('#flow-strip .flow-control');
      await expect(control).toHaveText('Start');
      await control.click();
      await expect.poll(() => existsSync(`${verdictHold}.pids`), { timeout: 60_000 }).toBe(true);
      const attentionStatus = await statusDeadline(controller.page, repo, [/needs? (?:a )?human|human.*needed/i, /stop.for.a.human|automatic.*halt/i]);
      rmSync(verdictHold);
      const stateFile = join(repo, '.agent-terminal', 'loop', 'run-state.yaml');
      await expect.poll(() => { try { return readFileSync(stateFile, 'utf8'); } catch { return ''; } }, { timeout: 60_000 }).toContain('verdict: stop for a human');
      const readout = terminal.page.locator('#flow-strip .loopstat');
      if (await readout.getAttribute('aria-expanded') !== 'true') await readout.click();
      const approve = terminal.page.locator('#loop-panel [data-gate-option="approve"]');
      await expect(approve).toBeVisible();
      const source = await terminal.page.evaluate(directory => window.flow.state(directory), repo);
      expect(source.loop?.humanNeeded).toBe(true);
      const { matched: shown, texts: attentionTexts } = await attentionStatus();
      expect.soft({ ['attention within two seconds including verdict dispatch']: shown[0] }).toEqual({ ['attention within two seconds including verdict dispatch']: true });
      expect.soft({ ['halt reason within the same deadline']: shown[1] }).toEqual({ ['halt reason within the same deadline']: true });
      expect.soft({ ['gate status within shared deadline']: attentionTexts.some(text => text.includes(source.loop!.status)) }).toEqual({ ['gate status within shared deadline']: true });
      if (source.loop?.verdictReason) expect.soft({ ['full reason within shared deadline']: attentionTexts.some(text => text.includes(source.loop!.verdictReason!)) }).toEqual({ ['full reason within shared deadline']: true });
      const pane = cardLocator(controller.page, repo);
      const bringForward = bringForwardLocator(pane);
      if (action === 'resolve') {
        const cleared = await statusDeadline(controller.page, repo, [/verify/]);
        await approve.click();
        await expect(terminal.page.locator('#flow-strip')).toContainText('verify');
        const resolution = await cleared();
        expect.soft(resolution.matched[0]).toBe(true);
        expect.soft(resolution.texts.some(text => /verify/.test(text) && !/needs? (?:a )?human|human.*needed|stop for a human/i.test(text) && (!source.loop?.verdictReason || !text.includes(source.loop.verdictReason)))).toBe(true);
        await expect.soft(pane).not.toContainText(/needs? (?:a )?human|stop for a human/i);
      } else {
        await expect(bringForward).toBeVisible();
        if (action === 'click') await bringForward.click();
        else { await bringForward.focus(); await controller.page.keyboard.press('Enter'); }
        await expect.soft.poll(() => terminal.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused())).toBe(true);
        expect.soft((await terminal.page.evaluate(directory => window.flow.state(directory), repo)).loop?.humanNeeded).toBe(true);
        await expect.soft(pane).toContainText(/needs? (?:a )?human|human.*needed/i, { timeout: DISPLAY_BOUND_MS });
        await expect.soft(pane).toContainText(source.loop!.status, { timeout: DISPLAY_BOUND_MS });
        if (source.loop?.verdictReason) await expect.soft(pane).toContainText(source.loop.verdictReason, { timeout: DISPLAY_BOUND_MS });
        await expect.soft(pane).toContainText(/stop.for.a.human|automatic.*halt/i, { timeout: DISPLAY_BOUND_MS });
      }
    } finally {
      try { await h.dispose(); }
      finally { rmSync(repo, { recursive: true, force: true }); rmSync(binDir, { recursive: true, force: true }); }
    }
  });
}
