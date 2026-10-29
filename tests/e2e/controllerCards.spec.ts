import { expect, test, type Locator, type Page } from '@playwright/test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createControllerDesktopHarness } from './controllerDesktop';
import { setContentWidth } from './controllerHarness';
import { autoGateFlowYaml, loopRoster, seedAutoGateRepo, seedTrustedFlow } from './autoGateHarness';
import { exampleConfigDir, seedFakeAgentV2, seedFakeGhGit } from './fakeTools';
import { exampleConsolidatorOutput } from '../../src/shared/consolidatorOutput';
import { shellQuote } from '../../src/shared/shellQuote';
import { bringForwardLocator, cardHeaderLocator, cardLocator, themeControlLocator, dismissLocator, dismissLoopMessageLocator, headerLabels, paintedStatusOf, statusRowLocator, unshownCounts, windowHeaderLocator } from '../helpers/controllerCards';
import { STATUS_CASES, type StatusCase } from '../helpers/controllerStatusFixture';
import { connectScriptedTerminal, type ScriptedControllerTerminal } from '../helpers/scriptedControllerTerminal';

const terminalTarget = { kind: 'development' as const, entry: resolve('out/main/index.js') };
const controllerTarget = { kind: 'development' as const, entry: resolve('out/main/controller.js') };
/** A real agent's activity at a human gate is whatever it last did, so a gated card's status names any activity word. */
const NEEDS_A_HUMAN = /^Needs a human · (?:Working|Idle|Activity unavailable)$/;

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
    await expect.soft(statusRowLocator(cardA)).toHaveText(NEEDS_A_HUMAN);
    await expect.soft(cardA).toContainText(gate.loop!.status);
    await expect.soft(cardA).toContainText(gate.loop!.verdictReason!);
    await expect.soft(statusRowLocator(cardB)).toHaveText('Working');
    const summary = { 'need a human': 1, working: 1 } as Record<string, number>;
    await expect.soft.poll(async () => unshownCounts((await windowHeaderLocator(controller.page).allTextContents()).join(' '),
      headerLabels(label => summary[label] ?? 0, 2, 2))).toEqual([]);
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
    await expect.soft(statusRowLocator(cardA)).toHaveText(NEEDS_A_HUMAN);
    await expect.soft(cardA.getByText(gate.loop!.verdictReason!)).toBeVisible();

    await focusController(terminals);
    await bringForwardLocator(cardA).click();
    await expect.poll(async () => [await focused(a), await focused(b)]).toEqual([true, false]);
    await expect.soft(headerA).toHaveAttribute('aria-expanded', 'true');

    terminals.releaseWorking();
    await terminals.workingGated();
    await expect.soft(statusRowLocator(cardB)).toHaveText(NEEDS_A_HUMAN);
    await expect.soft(headerB).toHaveAttribute('aria-expanded', 'true');
    await expect.soft(statusRowLocator(cardB)).toBeVisible();

    await focusController(terminals);
    await use(headerB, header => header.click());
    await expect.soft(headerB).toHaveAttribute('aria-expanded', 'false');
    await expect.soft(headerB).toContainText('Needs a human');
    await expect.soft(statusRowLocator(cardB)).toBeHidden();
    await noneCameForward();

    await setContentWidth(controller, 640);
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

test('a terminal\'s loop error shows on its card as an error, a notice does not, and the card\'s Dismiss reaches the terminal', { tag: '@ownapp' }, async () => {
  test.setTimeout(180_000);
  const h = await createControllerDesktopHarness();
  const clients: ScriptedControllerTerminal[] = [];
  try {
    const controller = await h.launch(controllerTarget, h.fixture.nonGit);
    await expect(controller.page.getByText(/no terminals connected/i)).toBeVisible();
    const [directory] = h.fixture.repositories;
    const terminal = await connectScriptedTerminal(h.fixture.home, { launchDirectory: directory, repositoryRoot: directory });
    clients.push(terminal);
    const card = cardLocator(controller.page, directory);
    for (const key of ['loop-error', 'loop-notice'] as const) {
      const shown = STATUS_CASES[key];
      await terminal.sendStatus(shown.terminal.work!);
      await expect.soft(statusRowLocator(card)).toHaveText(shown.text);
      await expect.soft.poll(() => paintedStatusOf(card)).toEqual({ accent: shown.statusClass, text: shown.statusClass });
      await expect(card).toContainText(shown.terminal.work!.loopMessage!.reason);
      await dismissLoopMessageLocator(card).click();
      await expect.poll(() => terminal.loopMessageDismissals().at(-1)).toBe(shown.terminal.work!.loopMessage!.id);
    }
    await terminal.sendStatus({ ...STATUS_CASES['loop-notice'].terminal.work!, loopMessage: null });
    await expect(dismissLoopMessageLocator(card)).toHaveCount(0);
  } finally {
    try { await Promise.all(clients.map(client => client.close())); }
    finally { await h.dispose(); }
  }
});

test('a card with a condition is coloured and counted by its agent\'s activity', { tag: '@ownapp' }, async () => {
  test.setTimeout(180_000);
  const h = await createControllerDesktopHarness();
  const clients: ScriptedControllerTerminal[] = [];
  try {
    const controller = await h.launch(controllerTarget, h.fixture.nonGit);
    await expect(controller.page.getByText(/no terminals connected/i)).toBeVisible();
    const [gatedDirectory, failedDirectory] = h.fixture.repositories;
    const [gated, failed] = await Promise.all([gatedDirectory, failedDirectory].map(async directory => {
      const client = await connectScriptedTerminal(h.fixture.home, { launchDirectory: directory, repositoryRoot: directory });
      clients.push(client);
      return client;
    }));
    const cardA = cardLocator(controller.page, gatedDirectory);
    const cardB = cardLocator(controller.page, failedDirectory);
    const shows = async (a: StatusCase, b: StatusCase) => {
      await gated.sendStatus(a.terminal.work!);
      await failed.sendStatus(b.terminal.work!);
      await expect.soft(statusRowLocator(cardA)).toHaveText(a.text);
      await expect.soft(statusRowLocator(cardB)).toHaveText(b.text);
      await expect.soft.poll(() => paintedStatusOf(cardA)).toEqual({ accent: a.statusClass, text: a.statusClass });
      await expect.soft.poll(() => paintedStatusOf(cardB)).toEqual({ accent: b.statusClass, text: b.statusClass });
      await expect.soft.poll(async () => unshownCounts((await windowHeaderLocator(controller.page).allTextContents()).join(' '),
        headerLabels(label => [a, b].filter(c => c.summary === label).length, 2, 2))).toEqual([]);
    };
    await shows(STATUS_CASES['needs-human-working'], STATUS_CASES['flow-error-working']);
    await shows(STATUS_CASES['needs-human'], STATUS_CASES['flow-error']);
  } finally {
    try { await Promise.all(clients.map(client => client.close())); }
    finally { await h.dispose(); }
  }
});

test('theme survives restart: Dark theme applies at once and after the controller restarts', { tag: '@ownapp' }, async () => {
  test.setTimeout(180_000);
  const h = await createControllerDesktopHarness();
  const paths: string[] = [];
  try {
    const { controller, gated, working } = await twoTerminals(h, paths);
    const painted = (page: Page) => page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    await use(themeControlLocator(controller.page, { on: false }), control => control.click());
    expect.soft(await painted(controller.page)).toBe('dark');
    await expect.soft.poll(() => controller.page.evaluate(() => window.controller.getTheme())).toBe('dark');

    await controller.app.close();
    const restarted = await h.launch(controllerTarget, h.fixture.nonGit, { profile: controller.profile });
    const cardA = cardLocator(restarted.page, gated);
    const cardB = cardLocator(restarted.page, working);
    await expect.soft(themeControlLocator(restarted.page, { on: true })).toBeVisible();
    await expect.soft.poll(() => painted(restarted.page)).toBe('dark');
    await expect(statusRowLocator(cardA)).toHaveText(NEEDS_A_HUMAN, { timeout: 30_000 });
    await expect(statusRowLocator(cardB)).toHaveText('Working', { timeout: 30_000 });
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
