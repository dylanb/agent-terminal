import { expect, test, type Locator, type Page } from '@playwright/test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createControllerDesktopHarness } from './controllerDesktop';
import { setContentWidth } from './controllerHarness';
import { autoGateFlowYaml, loopRoster, seedAutoGateRepo, seedTrustedFlow } from './autoGateHarness';
import { exampleConfigDir, seedFakeAgentV2, seedFakeGhGit } from './fakeTools';
import { exampleConsolidatorOutput } from '../../src/shared/consolidatorOutput';
import { shellQuote } from '../../src/shared/shellQuote';
import { accentLocator, bringForwardLocator, cardLocator, dismissLocator, headerLabels, statusRowLocator, unshownCounts, windowHeaderLocator } from '../helpers/controllerCards';
import { expectedColor, type StatusToken } from '../helpers/designTokens';
import { mismatchedTokens, paintColors } from '../helpers/tokenProbe';

const terminalTarget = { kind: 'development' as const, entry: resolve('out/main/index.js') };
const controllerTarget = { kind: 'development' as const, entry: resolve('out/main/controller.js') };

async function paintedColor(part: Locator, property: 'background-color' | 'color'): Promise<string | undefined> {
  const values = await part.evaluateAll((elements, property) => elements.map(element => getComputedStyle(element).getPropertyValue(property)), property);
  return values[0];
}

/** Each card part whose painted colour is not its light status token, or that is not painted at all. */
async function offToken(page: Page, reads: { label: string; part: Locator; property: 'background-color' | 'color'; token: StatusToken }[]): Promise<string[]> {
  const expected = await page.evaluate(paintColors, reads.map(read => expectedColor(read.token, 'light')));
  const violations: string[] = [];
  for (const [index, read] of reads.entries()) {
    const painted = await paintedColor(read.part, read.property);
    if (painted === undefined) violations.push(`${read.label} is not painted`);
    else violations.push(...mismatchedTokens([read.label], { [read.label]: painted }, [expected[index]]));
  }
  return violations;
}

type Launched = Awaited<ReturnType<Awaited<ReturnType<typeof createControllerDesktopHarness>>['launch']>>;
const focused = (launched: Launched) => launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused());

test('status cards on real terminals', { tag: '@ownapp' }, async () => {
  test.setTimeout(120_000);
  const h = await createControllerDesktopHarness();
  const gated = seedAutoGateRepo('controller-cards-gate-', 'red');
  const working = seedAutoGateRepo('controller-cards-working-', 'red');
  const gatedTools = seedFakeGhGit('controller-cards-gate-tools-', { realCommitOps: true });
  const workingTools = seedFakeGhGit('controller-cards-working-tools-', { realCommitOps: true });
  try {
    for (const [repo, flow] of [[gated, 'cards-gate-flow'], [working, 'cards-working-flow']] as const) {
      seedTrustedFlow(h.fixture.home, repo, flow, autoGateFlowYaml([
        { id: 'red', kind: 'loop', loop: 'red-loop', authority: 'auto' }, { id: 'verify', kind: 'manual' },
      ], flow));
    }
    const verdictHold = join(gatedTools.binDir, 'verdict-hold');
    writeFileSync(verdictHold, 'hold');
    seedFakeAgentV2(gatedTools.binDir, {
      holdConsolidate: { sentinel: verdictHold },
      stepId: 'red', artifactRel: '.agent-terminal/loop/artifacts/red-result.json', work: 'red',
      roster: loopRoster('red-loop'), verdicts: [exampleConsolidatorOutput('stop for a human', loopRoster('red-loop'))],
    });
    const workHold = join(workingTools.binDir, 'work-hold');
    writeFileSync(workHold, 'hold');
    seedFakeAgentV2(workingTools.binDir, {
      hold: { sentinel: workHold, keepActive: true },
      stepId: 'red', artifactRel: '.agent-terminal/loop/artifacts/red-result.json', work: 'red', roster: loopRoster('red-loop'),
    });
    Object.assign(h.fixture.env, { CLAUDE_CONFIG_DIR: exampleConfigDir, APP_SUBMIT_DELAY_MS: '100' });
    const controller = await h.launch(controllerTarget, h.fixture.nonGit);
    const start = async (repo: string, tools: { binDir: string; logFile: string }): Promise<Launched> => {
      Object.assign(h.fixture.env, { PATH: `${tools.binDir}:${process.env.PATH}`, FAKE_GHGIT_LOG: tools.logFile });
      const terminal = await h.launch(terminalTarget, repo);
      await terminal.page.locator('.xterm-screen').click();
      await terminal.page.keyboard.type(`cd ${shellQuote(repo)}; fake-agent`);
      await terminal.page.keyboard.press('Enter');
      const control = terminal.page.locator('#flow-strip .flow-control');
      await expect(control).toHaveText('Start');
      await control.click();
      return terminal;
    };
    const a = await start(gated, gatedTools);
    await expect.poll(() => existsSync(`${verdictHold}.pids`), { timeout: 60_000 }).toBe(true);
    rmSync(verdictHold);
    const stateFile = join(gated, '.agent-terminal', 'loop', 'run-state.yaml');
    await expect.poll(() => { try { return readFileSync(stateFile, 'utf8'); } catch { return ''; } }, { timeout: 60_000 }).toContain('verdict: stop for a human');
    const gate = await a.page.evaluate(directory => window.flow.state(directory), gated);
    expect({ humanNeeded: gate.loop?.humanNeeded, reason: Boolean(gate.loop?.verdictReason) }).toEqual({ humanNeeded: true, reason: true });
    const b = await start(working, workingTools);
    await expect.poll(() => existsSync(`${workHold}.pids`), { timeout: 60_000 }).toBe(true);

    const cardA = cardLocator(controller.page, gated);
    const cardB = cardLocator(controller.page, working);
    await expect.soft(statusRowLocator(cardA)).toHaveText('Needs a human');
    await expect.soft(cardA).toContainText(gate.loop!.status);
    await expect.soft(cardA).toContainText(gate.loop!.verdictReason!);
    await expect.soft(statusRowLocator(cardB)).toHaveText('Working');
    const summary = { 'need a human': 1, working: 1 } as Record<string, number>;
    await expect.soft.poll(async () => unshownCounts((await windowHeaderLocator(controller.page).allTextContents()).join(' '),
      headerLabels(label => summary[label] ?? 0, 2, 2))).toEqual([]);
    expect.soft(await offToken(controller.page, [
      { label: 'A accent', part: accentLocator(cardA), property: 'background-color', token: '--status-needs-human' },
      { label: 'A status row', part: statusRowLocator(cardA), property: 'color', token: '--status-needs-human-text' },
      { label: 'B accent', part: accentLocator(cardB), property: 'background-color', token: '--status-working' },
      { label: 'B status row', part: statusRowLocator(cardB), property: 'color', token: '--status-working-text' },
    ])).toEqual([]);

    const cardRows = async (): Promise<number> => {
      const tops = (await Promise.all([cardA, cardB].map(card =>
        card.evaluateAll(cards => cards.map(element => Math.round(element.getBoundingClientRect().top)))))).flat();
      return tops.length === 2 ? new Set(tops).size : 0;
    };
    await setContentWidth(controller, 639);
    await expect.soft.poll(cardRows).toBe(2);
    await setContentWidth(controller, 640);
    await expect.soft.poll(cardRows).toBe(1);

    await controller.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus());
    await expect.poll(async () => [await focused(controller), await focused(a), await focused(b)]).toEqual([true, false, false]);
    const bringForward = bringForwardLocator(cardA);
    await expect(bringForward).toBeVisible();
    await bringForward.click();
    await expect.poll(async () => [await focused(a), await focused(b)]).toEqual([true, false]);
  } finally {
    try { await h.dispose(); }
    finally {
      for (const path of [gated, working, gatedTools.binDir, workingTools.binDir]) rmSync(path, { recursive: true, force: true });
    }
  }
});

test('a closed terminal leaves a Disconnected card whose Dismiss removes it', { tag: '@ownapp' }, async () => {
  const h = await createControllerDesktopHarness();
  try {
    const controller = await h.launch(controllerTarget, h.fixture.nonGit);
    const directory = h.fixture.repositories[0];
    const terminal = await h.launch(terminalTarget, directory);
    await expect(controller.page.locator('body')).toContainText(directory);
    await terminal.app.close();
    const card = cardLocator(controller.page, directory);
    await expect.soft(statusRowLocator(card)).toHaveText('Disconnected');
    const dismiss = dismissLocator(card);
    await expect(dismiss).toBeVisible();
    await dismiss.click();
    await expect(card).toHaveCount(0);
  } finally { await h.dispose(); }
});
