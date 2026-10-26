import { expect, test } from '@playwright/test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createControllerDesktopHarness } from './controllerDesktop';
import { observeStatus, STATUS_BUDGET_MS } from './controllerStatusObservation';
import { autoGateFlowYaml, loopRoster, seedAutoGateRepo, seedTrustedFlow } from './autoGateHarness';
import { exampleConfigDir, seedFakeAgentV2, seedFakeGhGit } from './fakeTools';
import { exampleConsolidatorOutput } from '../../src/shared/consolidatorOutput';
import { shellQuote } from '../../src/shared/shellQuote';

const terminalTarget = { kind: 'development' as const, entry: resolve('out/main/index.js') };
const controllerTarget = { kind: 'development' as const, entry: resolve('out/main/controller.js') };

for (const action of ['click', 'keyboard', 'resolve'] as const) {
  test(`real human gate ${action} preserves attention until terminal resolution`, { tag: '@ownapp' }, async () => {
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
      const screen = terminal.page.locator('.xterm-screen');
      await screen.click();
      await terminal.page.keyboard.type(`cd ${shellQuote(repo)}; fake-agent`);
      await terminal.page.keyboard.press('Enter');
      const control = terminal.page.locator('#flow-strip .flow-control');
      await expect(control).toHaveText('Start');
      await control.click();
      await expect.poll(() => existsSync(`${verdictHold}.pids`), { timeout: 60_000 }).toBe(true);
      const attentionStatus = await observeStatus(controller.page, repo, { attention: /needs? (?:a )?human|human.*needed/i, halt: /stop.for.a.human|automatic.*halt/i });
      rmSync(verdictHold);
      const stateFile = join(repo, '.agent-terminal', 'loop', 'run-state.yaml');
      await expect.poll(() => { try { return readFileSync(stateFile, 'utf8'); } catch { return ''; } }, { timeout: 60_000 }).toContain('verdict: stop for a human');
      const readout = terminal.page.locator('#flow-strip .loopstat');
      if (await readout.getAttribute('aria-expanded') !== 'true') await readout.click();
      const approve = terminal.page.locator('#loop-panel [data-gate-option="approve"]');
      await expect(approve).toBeVisible();
      const source = await terminal.page.evaluate(directory => window.flow.state(directory), repo);
      expect(source.loop?.humanNeeded).toBe(true);
      const attention = await attentionStatus();
      expect.soft({ ['attention shown after verdict dispatch']: attention.shown.attention }).toEqual({ ['attention shown after verdict dispatch']: true });
      expect.soft({ ['halt reason shown']: attention.shown.halt }).toEqual({ ['halt reason shown']: true });
      expect.soft({ ['gate status shown']: attention.ever(source.loop!.status) }).toEqual({ ['gate status shown']: true });
      if (source.loop?.verdictReason) expect.soft({ ['full reason shown']: attention.ever(source.loop!.verdictReason!) }).toEqual({ ['full reason shown']: true });
      const pane = controller.page.getByRole('button', { name: repo, exact: false });
      if (action === 'resolve') {
        await approve.click();
        await expect(terminal.page.locator('#flow-strip')).toContainText('verify');
        await expect.soft(pane).toContainText(/verify/, { timeout: STATUS_BUDGET_MS });
        await expect.soft(pane).not.toContainText(/needs? (?:a )?human|human.*needed|stop for a human/i, { timeout: STATUS_BUDGET_MS });
        if (source.loop?.verdictReason) await expect.soft(pane).not.toContainText(source.loop.verdictReason, { timeout: STATUS_BUDGET_MS });
      } else {
        if (action === 'click') await pane.click();
        else { await pane.focus(); await controller.page.keyboard.press('Enter'); }
        await expect.soft.poll(() => terminal.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused())).toBe(true);
        expect.soft((await terminal.page.evaluate(directory => window.flow.state(directory), repo)).loop?.humanNeeded).toBe(true);
        await expect.soft(pane).toContainText(/needs? (?:a )?human|human.*needed/i, { timeout: STATUS_BUDGET_MS });
        await expect.soft(pane).toContainText(source.loop!.status, { timeout: STATUS_BUDGET_MS });
        if (source.loop?.verdictReason) await expect.soft(pane).toContainText(source.loop.verdictReason, { timeout: STATUS_BUDGET_MS });
        await expect.soft(pane).toContainText(/stop.for.a.human|automatic.*halt/i, { timeout: STATUS_BUDGET_MS });
      }
    } finally {
      try { await h.dispose(); }
      finally { rmSync(repo, { recursive: true, force: true }); rmSync(binDir, { recursive: true, force: true }); }
    }
  });
}
