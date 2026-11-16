import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import { createControllerDesktopHarness } from './controllerDesktop';
import { observeStatus, STATUS_BUDGET_MS } from './controllerStatusObservation';
import { heldHumanGate, type HeldHumanGate } from './autoGateHarness';
import { bringForwardLocator, cardLocator } from '../helpers/controllerCards';

const terminalTarget = { kind: 'development' as const, entry: resolve('out/main/index.js') };
const controllerTarget = { kind: 'development' as const, entry: resolve('out/main/controller.js') };

for (const action of ['click', 'keyboard', 'resolve'] as const) {
  test(`real human gate ${action} preserves attention until terminal resolution`, { tag: '@ownapp' }, async () => {
    test.setTimeout(240_000);
    const h = await createControllerDesktopHarness();
    let gate: HeldHumanGate | undefined;
    try {
      gate = heldHumanGate(h.fixture, 'controller-attention');
      const repo = gate.repo;
      const controller = await h.launch(controllerTarget, h.fixture.nonGit);
      const terminal = await h.launch(terminalTarget, repo);
      await gate.start(terminal.page);
      const attentionStatus = await observeStatus(controller.page, repo, { attention: /needs? (?:a )?human|human.*needed/i, halt: /stop.for.a.human|automatic.*halt/i });
      await gate.release();
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
      const pane = cardLocator(controller.page, repo);
      const bringForward = bringForwardLocator(pane);
      if (action === 'resolve') {
        await approve.click();
        await expect(terminal.page.locator('#flow-strip')).toContainText('Verify');
        await expect.soft(pane).toContainText(/Verify/, { timeout: STATUS_BUDGET_MS });
        await expect.soft(pane).not.toContainText(/needs? (?:a )?human|human.*needed|stop for a human/i, { timeout: STATUS_BUDGET_MS });
        if (source.loop?.verdictReason) await expect.soft(pane).not.toContainText(source.loop.verdictReason, { timeout: STATUS_BUDGET_MS });
      } else {
        await expect(bringForward).toBeVisible();
        if (action === 'click') await bringForward.click();
        else { await bringForward.focus(); await controller.page.keyboard.press('Enter'); }
        await expect.soft.poll(() => terminal.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused())).toBe(true);
        expect.soft((await terminal.page.evaluate(directory => window.flow.state(directory), repo)).loop?.humanNeeded).toBe(true);
        await expect.soft(pane).toContainText(/needs? (?:a )?human|human.*needed/i, { timeout: STATUS_BUDGET_MS });
        await expect.soft(pane).toContainText(source.loop!.status, { timeout: STATUS_BUDGET_MS });
        if (source.loop?.verdictReason) await expect.soft(pane).toContainText(source.loop.verdictReason, { timeout: STATUS_BUDGET_MS });
        await expect.soft(pane).toContainText(/stop.for.a.human|automatic.*halt/i, { timeout: STATUS_BUDGET_MS });
      }
    } finally {
      try { await h.dispose(); }
      finally { gate?.dispose(); }
    }
  });
}
