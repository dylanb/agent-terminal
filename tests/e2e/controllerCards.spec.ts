import { expect, test, type Locator, type Page } from '@playwright/test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createControllerDesktopHarness } from './controllerDesktop';
import { setContentWidth } from './controllerHarness';
import { autoGateFlowYaml, loopRoster, seedAutoGateRepo, seedTrustedFlow } from './autoGateHarness';
import { exampleConfigDir, seedFakeAgentV2, seedFakeGhGit } from './fakeTools';
import { exampleConsolidatorOutput } from '../../src/shared/consolidatorOutput';
import { shellQuote } from '../../src/shared/shellQuote';
import { accentLocator, bringForwardLocator, CARD_SELECTOR, cardHeaderLocator, cardLocator, darkThemeLocator, dismissLocator, headerLabels, statusRowLocator, unshownCounts, windowHeaderLocator } from '../helpers/controllerCards';
import { expectedColor, type StatusToken, type Theme } from '../helpers/designTokens';
import { mismatchedTokens, paintColors } from '../helpers/tokenProbe';

const terminalTarget = { kind: 'development' as const, entry: resolve('out/main/index.js') };
const controllerTarget = { kind: 'development' as const, entry: resolve('out/main/controller.js') };

async function paintedColor(part: Locator, property: 'background-color' | 'color'): Promise<string | undefined> {
  const values = await part.evaluateAll((elements, property) => elements.map(element => getComputedStyle(element).getPropertyValue(property)), property);
  return values[0];
}

/** Each card part whose painted colour is not its status token in `theme`, or that is not painted at all. */
async function offToken(page: Page, theme: Theme, reads: { label: string; part: Locator; property: 'background-color' | 'color'; token: StatusToken }[]): Promise<string[]> {
  const expected = await page.evaluate(paintColors, reads.map(read => expectedColor(read.token, theme)));
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

interface TwoTerminals {
  controller: Launched;
  a: Launched;
  b: Launched;
  gated: string;
  working: string;
  gate: Awaited<ReturnType<Window['flow']['state']>>;
  /** Releases B's held turn, after which B's consolidate verdict stops it at a human gate. */
  releaseWorking(): void;
  /** Resolves once B's run has stopped for a human. */
  workingGated(): Promise<void>;
}

/** The controller, then A stopped at a human gate, then B holding a turn that keeps it active (Working). `paths`
 *  collects what the caller removes afterwards. */
async function twoTerminals(h: Awaited<ReturnType<typeof createControllerDesktopHarness>>, paths: string[]): Promise<TwoTerminals> {
  const gated = seedAutoGateRepo('controller-cards-gate-', 'red');
  const working = seedAutoGateRepo('controller-cards-working-', 'red');
  const gatedTools = seedFakeGhGit('controller-cards-gate-tools-', { realCommitOps: true });
  const workingTools = seedFakeGhGit('controller-cards-working-tools-', { realCommitOps: true });
  paths.push(gated, working, gatedTools.binDir, workingTools.binDir);
  for (const [repo, flow] of [[gated, 'cards-gate-flow'], [working, 'cards-working-flow']] as const) {
    seedTrustedFlow(h.fixture.home, repo, flow, autoGateFlowYaml([
      { id: 'red', kind: 'loop', loop: 'red-loop', authority: 'auto' }, { id: 'verify', kind: 'manual' },
    ], flow));
  }
  const stopForHuman = [exampleConsolidatorOutput('stop for a human', loopRoster('red-loop'))];
  const verdictHold = join(gatedTools.binDir, 'verdict-hold');
  writeFileSync(verdictHold, 'hold');
  seedFakeAgentV2(gatedTools.binDir, {
    holdConsolidate: { sentinel: verdictHold },
    stepId: 'red', artifactRel: '.agent-terminal/loop/artifacts/red-result.json', work: 'red',
    roster: loopRoster('red-loop'), verdicts: stopForHuman,
  });
  const workHold = join(workingTools.binDir, 'work-hold');
  writeFileSync(workHold, 'hold');
  seedFakeAgentV2(workingTools.binDir, {
    hold: { sentinel: workHold, keepActive: true },
    stepId: 'red', artifactRel: '.agent-terminal/loop/artifacts/red-result.json', work: 'red',
    roster: loopRoster('red-loop'), verdicts: stopForHuman,
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
  const stoppedForHuman = async (repo: string) => {
    const stateFile = join(repo, '.agent-terminal', 'loop', 'run-state.yaml');
    await expect.poll(() => { try { return readFileSync(stateFile, 'utf8'); } catch { return ''; } }, { timeout: 60_000 }).toContain('verdict: stop for a human');
  };
  const a = await start(gated, gatedTools);
  await expect.poll(() => existsSync(`${verdictHold}.pids`), { timeout: 60_000 }).toBe(true);
  rmSync(verdictHold);
  await stoppedForHuman(gated);
  const gate = await a.page.evaluate(directory => window.flow.state(directory), gated);
  expect({ humanNeeded: gate.loop?.humanNeeded, reason: Boolean(gate.loop?.verdictReason) }).toEqual({ humanNeeded: true, reason: true });
  const b = await start(working, workingTools);
  await expect.poll(() => existsSync(`${workHold}.pids`), { timeout: 60_000 }).toBe(true);
  return {
    controller, a, b, gated, working, gate,
    releaseWorking: () => rmSync(workHold),
    workingGated: () => stoppedForHuman(working),
  };
}

/** How many rows A's and B's cards sit on as painted: 1 side by side, 2 in one column, 0 while either is missing. */
const cardRows = ({ controller, gated, working }: TwoTerminals): Promise<number> => controller.page.evaluate(({ directories, cardSelector }) => {
  const tops = [...document.querySelectorAll(cardSelector)]
    .filter(element => directories.some(directory => element.textContent?.includes(directory)))
    .map(element => Math.round(element.getBoundingClientRect().top));
  return tops.length === 2 ? new Set(tops).size : 0;
}, { directories: [gated, working], cardSelector: CARD_SELECTOR });

const removeAll = (paths: readonly string[]) => { for (const path of paths) rmSync(path, { recursive: true, force: true }); };

/** Focuses the controller window and waits until no terminal window is focused, so a later read of a terminal's
 *  focus shows only what the next action did. */
async function focusController({ controller, a, b }: TwoTerminals): Promise<void> {
  await controller.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus());
  await expect.poll(async () => [await focused(controller), await focused(a), await focused(b)]).toEqual([true, false, false]);
}

/** Runs `action` on `control` once it is visible. A control that never appears is a soft failure here, so the
 *  later Land checks still report instead of the test stopping at the action. */
async function use(control: Locator, action: (control: Locator) => Promise<void>): Promise<void> {
  await expect.soft(control).toBeVisible();
  if (await control.isVisible()) await action(control);
}

test('status cards on real terminals', { tag: '@ownapp' }, async () => {
  test.setTimeout(120_000);
  const h = await createControllerDesktopHarness();
  const paths: string[] = [];
  try {
    const terminals = await twoTerminals(h, paths);
    const { controller, a, b, gated, working, gate } = terminals;
    const cardA = cardLocator(controller.page, gated);
    const cardB = cardLocator(controller.page, working);
    await expect.soft(statusRowLocator(cardA)).toHaveText('Needs a human');
    await expect.soft(cardA).toContainText(gate.loop!.status);
    await expect.soft(cardA).toContainText(gate.loop!.verdictReason!);
    await expect.soft(statusRowLocator(cardB)).toHaveText('Working');
    const summary = { 'need a human': 1, working: 1 } as Record<string, number>;
    await expect.soft.poll(async () => unshownCounts((await windowHeaderLocator(controller.page).allTextContents()).join(' '),
      headerLabels(label => summary[label] ?? 0, 2, 2))).toEqual([]);
    expect.soft(await offToken(controller.page, 'light', [
      { label: 'A accent', part: accentLocator(cardA), property: 'background-color', token: '--status-needs-human' },
      { label: 'A status row', part: statusRowLocator(cardA), property: 'color', token: '--status-needs-human-text' },
      { label: 'B accent', part: accentLocator(cardB), property: 'background-color', token: '--status-working' },
      { label: 'B status row', part: statusRowLocator(cardB), property: 'color', token: '--status-working-text' },
    ])).toEqual([]);

    await setContentWidth(controller, 639);
    await expect.soft.poll(() => cardRows(terminals)).toBe(2);
    await setContentWidth(controller, 640);
    await expect.soft.poll(() => cardRows(terminals)).toBe(1);

    await focusController(terminals);
    const bringForward = bringForwardLocator(cardA);
    await expect(bringForward).toBeVisible();
    await bringForward.click();
    await expect.poll(async () => [await focused(a), await focused(b)]).toEqual([true, false]);
  } finally {
    try { await h.dispose(); }
    finally { removeAll(paths); }
  }
});

test('tracer bullet: one column, Bring forward, a new human gate and header clicks and keys', { tag: '@ownapp' }, async () => {
  test.setTimeout(300_000);
  const h = await createControllerDesktopHarness();
  const paths: string[] = [];
  try {
    const terminals = await twoTerminals(h, paths);
    const { controller, a, b, gated, working, gate } = terminals;
    const cardA = cardLocator(controller.page, gated);
    const cardB = cardLocator(controller.page, working);
    const headerA = cardHeaderLocator(cardA, gated);
    const headerB = cardHeaderLocator(cardB, working);
    const noneCameForward = async () => expect.soft([await focused(a), await focused(b)]).toEqual([false, false]);
    await expect(statusRowLocator(cardB)).toHaveText('Working');

    await setContentWidth(controller, 639);
    await expect.soft(headerB).toHaveAttribute('aria-expanded', 'false');
    await expect.soft(headerB).toContainText('Working');
    await expect.soft(statusRowLocator(cardB)).toBeHidden();
    await expect.soft(headerA).toHaveAttribute('aria-expanded', 'true');
    await expect.soft(statusRowLocator(cardA)).toHaveText('Needs a human');
    await expect.soft(cardA.getByText(gate.loop!.verdictReason!)).toBeVisible();

    await focusController(terminals);
    await bringForwardLocator(cardA).click();
    await expect.poll(async () => [await focused(a), await focused(b)]).toEqual([true, false]);
    await expect.soft(headerA).toHaveAttribute('aria-expanded', 'true');

    terminals.releaseWorking();
    await terminals.workingGated();
    await expect.soft(statusRowLocator(cardB)).toHaveText('Needs a human');
    await expect.soft(headerB).toHaveAttribute('aria-expanded', 'true');
    await expect.soft(statusRowLocator(cardB)).toBeVisible();

    await focusController(terminals);
    await use(headerB, header => header.click());
    await expect.soft(headerB).toHaveAttribute('aria-expanded', 'false');
    await expect.soft(headerB).toContainText('Needs a human');
    await expect.soft(statusRowLocator(cardB)).toBeHidden();
    await noneCameForward();

    await setContentWidth(controller, 640);
    await expect.poll(() => cardRows(terminals)).toBe(1);
    await expect.soft(headerA).toHaveAttribute('aria-expanded', 'true');
    await expect.soft(headerB).toHaveAttribute('aria-expanded', 'false');

    await use(headerB, header => header.click());
    await expect.soft(headerB).toHaveAttribute('aria-expanded', 'true');
    await expect.soft(statusRowLocator(cardB)).toBeVisible();
    await noneCameForward();

    await use(headerB, async header => {
      await header.focus();
      await controller.page.keyboard.press('Enter');
    });
    await expect.soft(headerB).toHaveAttribute('aria-expanded', 'false');
    await use(headerB, () => controller.page.keyboard.press('Space'));
    await expect.soft(headerB).toHaveAttribute('aria-expanded', 'true');
    await expect.soft(headerB).toBeFocused();
    await noneCameForward();
  } finally {
    try { await h.dispose(); }
    finally { removeAll(paths); }
  }
});

test('theme survives restart: Dark theme paints the dark tokens at once and after the controller restarts', { tag: '@ownapp' }, async () => {
  test.setTimeout(180_000);
  const h = await createControllerDesktopHarness();
  const paths: string[] = [];
  try {
    const { controller, gated, working } = await twoTerminals(h, paths);
    const painted = (page: Page) => page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    await use(darkThemeLocator(controller.page, { on: false }), control => control.click());
    expect.soft(await painted(controller.page)).toBe('dark');
    await expect.soft.poll(() => controller.page.evaluate(() => window.controller.getTheme())).toBe('dark');

    await controller.app.close();
    const restarted = await h.launch(controllerTarget, h.fixture.nonGit, { profile: controller.profile });
    const cardA = cardLocator(restarted.page, gated);
    const cardB = cardLocator(restarted.page, working);
    await expect.soft(darkThemeLocator(restarted.page, { on: true })).toBeVisible();
    await expect.soft.poll(() => painted(restarted.page)).toBe('dark');
    await expect(statusRowLocator(cardA)).toHaveText('Needs a human', { timeout: 30_000 });
    await expect(statusRowLocator(cardB)).toHaveText('Working', { timeout: 30_000 });
    expect.soft(await offToken(restarted.page, 'dark', [
      { label: 'A accent', part: accentLocator(cardA), property: 'background-color', token: '--status-needs-human' },
      { label: 'A status row', part: statusRowLocator(cardA), property: 'color', token: '--status-needs-human-text' },
      { label: 'B accent', part: accentLocator(cardB), property: 'background-color', token: '--status-working' },
      { label: 'B status row', part: statusRowLocator(cardB), property: 'color', token: '--status-working-text' },
    ])).toEqual([]);
  } finally {
    try { await h.dispose(); }
    finally { removeAll(paths); }
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
