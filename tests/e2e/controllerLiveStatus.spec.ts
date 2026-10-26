import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createControllerDesktopHarness } from './controllerDesktop';
import { observeStatus, STATUS_BUDGET_MS } from './controllerStatusObservation';
import { autoGateFlowYaml, seedTrustedFlow } from './autoGateHarness';

const terminalTarget = { kind: 'development' as const, entry: resolve('out/main/index.js') };
const controllerTarget = { kind: 'development' as const, entry: resolve('out/main/controller.js') };

for (const stage of ['unassigned', 'assigned', 'completed'] as const) {
  test(`real terminal publishes ${stage} independently of ticket and activity`, { tag: '@ownapp' }, async () => {
    test.setTimeout(120_000);
    const h = await createControllerDesktopHarness();
    const repo = h.fixture.repositories[0];
    try {
      mkdirSync(join(repo, '.agent-terminal'), { recursive: true });
      seedTrustedFlow(h.fixture.home, repo, 'status-delivery', autoGateFlowYaml([{ id: 'implement', kind: 'manual' }], 'status-delivery'));
      writeFileSync(join(repo, '.agent-terminal', 'flow-state.yaml'), 'step: implement\nstatus: not_started\n');
      const controller = await h.launch(controllerTarget, h.fixture.nonGit);
      let status = await observeStatus(controller.page, repo, [/unassigned/i, /active|idle|quiet/i, /no ticket/i], 'registration');
      const terminal = await h.launch(terminalTarget, repo);
      const control = terminal.page.locator('#flow-strip .flow-control');
      await expect(control).toHaveText('Start');
      if (stage !== 'unassigned') {
        await status();
        status = await observeStatus(controller.page, repo, [/\bassigned\b/i, /active|idle|quiet/i, /no ticket/i]);
        await control.click();
        await expect(control).toHaveText('Advance');
      }
      if (stage === 'completed') {
        await status();
        status = await observeStatus(controller.page, repo, [/completed/i, /active|idle|quiet/i, /no ticket/i]);
        await control.click();
        await expect(control).toHaveText('Restart');
      }
      const pane = controller.page.getByRole('button', { name: repo, exact: false });
      const { matched: shown } = await status();
      expect.soft({ [`${stage} shown`]: shown[0] }).toEqual({ [`${stage} shown`]: true });
      expect.soft({ ['activity shown']: shown[1] }).toEqual({ ['activity shown']: true });
      expect.soft({ ['ticket availability shown']: shown[2] }).toEqual({ ['ticket availability shown']: true });
      if (stage !== 'unassigned') await expect.soft(pane).not.toContainText(/unassigned/i);
      await expect.soft(pane).not.toContainText(/needs? (?:a )?human/i);
    } finally { await h.dispose(); }
  });
}

test('real flow advancement updates only its fixed terminal pane', { tag: '@ownapp' }, async () => {
  test.setTimeout(180_000);
  const h = await createControllerDesktopHarness();
  const [left, right] = h.fixture.repositories;
  try {
    for (const [index, repo] of [left, right].entries()) {
      mkdirSync(join(repo, '.agent-terminal'), { recursive: true });
      seedTrustedFlow(h.fixture.home, repo, `delivery-${index}`, autoGateFlowYaml([{ id: `first-${index}`, kind: 'manual' }, { id: `second-${index}`, kind: 'manual' }], `delivery-${index}`));
      writeFileSync(join(repo, '.agent-terminal', 'flow-state.yaml'), `step: first-${index}\nstatus: not_started\n`);
    }
    const controller = await h.launch(controllerTarget, h.fixture.nonGit);
    const terminals = [await h.launch(terminalTarget, left), await h.launch(terminalTarget, right)];
    for (const terminal of terminals) {
      const control = terminal.page.locator('#flow-strip .flow-control');
      await expect(control).toHaveText('Start');
      await control.click();
      await expect(control).toHaveText('Advance');
    }
    await terminals[0].page.locator('#flow-strip .flow-control').click();
    await expect(terminals[0].page.locator('#flow-strip')).toContainText('second-0');
    const leftPane = controller.page.getByRole('button', { name: left, exact: false });
    const rightPane = controller.page.getByRole('button', { name: right, exact: false });
    await expect.soft(leftPane).toContainText('second-0', { timeout: STATUS_BUDGET_MS });
    await expect.soft(leftPane).toContainText('delivery-0', { timeout: STATUS_BUDGET_MS });
    await expect.soft(rightPane).toContainText('first-1', { timeout: STATUS_BUDGET_MS });
    await expect.soft(rightPane).toContainText('delivery-1', { timeout: STATUS_BUDGET_MS });
    await expect.soft(leftPane).not.toContainText(/first-0|first-1|second-1/);
    await expect.soft(rightPane).not.toContainText(/second-0|first-0/);
  } finally { await h.dispose(); }
});

test('hidden terminal flow changes reach the controller including source dispatch', { tag: '@ownapp' }, async () => {
  test.setTimeout(120_000);
  const h = await createControllerDesktopHarness();
  const repo = h.fixture.repositories[0];
  try {
    mkdirSync(join(repo, '.agent-terminal'), { recursive: true });
    seedTrustedFlow(h.fixture.home, repo, 'timed-flow', autoGateFlowYaml([{ id: 'prepare', kind: 'manual' }, { id: 'measure', kind: 'manual' }], 'timed-flow'));
    writeFileSync(join(repo, '.agent-terminal', 'flow-state.yaml'), 'step: prepare\nstatus: not_started\n');
    const controller = await h.launch(controllerTarget, h.fixture.nonGit);
    const terminal = await h.launch(terminalTarget, repo);
    const control = terminal.page.locator('#flow-strip .flow-control');
    await expect(control).toHaveText('Start');
    await control.click();
    await expect(control).toHaveText('Advance');
    await terminal.app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].hide(); });
    await terminal.page.evaluate(directory => window.flow.advance(directory), repo);
    await expect(controller.page.getByRole('button', { name: repo, exact: false })).toContainText('measure', { timeout: STATUS_BUDGET_MS });
  } finally { await h.dispose(); }
});
