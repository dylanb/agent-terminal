import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createControllerDesktopHarness } from './controllerDesktop';
import { STATUS_BUDGET_MS } from './controllerStatusObservation';
import { autoGateFlowYaml, loopRoster, seedAutoGateRepo, seedTrustedFlow } from './autoGateHarness';
import { exampleConfigDir, FAKE_AGENT_READY, seedFakeAgentSteps, seedFakeAgentV2, seedFakeGhGit } from './fakeTools';
import { fakeProcessPid, fakeProcessRunning, fakeSpawnLine, stopAllFakeProcesses, stopFakeProcess } from './fakeProcesses';
import { cardHeaderLocator, cardLocator, statusRowLocator, timelineEntriesLocator, unshownCounts, windowHeaderLocator } from '../helpers/controllerCards';
import { shellQuote } from '../../src/shared/shellQuote';

const terminalTarget = { kind: 'development' as const, entry: resolve('out/main/index.js') };
const controllerTarget = { kind: 'development' as const, entry: resolve('out/main/controller.js') };
const COMMAND = 'fake-suite';
// Long enough that a slow lookup never reads as no commands, so an Idle seen here is a lookup that found none.
const SLOW_LOOKUP_ENV = { APP_WAITING_LOOKUP_TIMEOUT_MS: String(STATUS_BUDGET_MS * 4) };
type RecordingWindow = Window & { waitingActivities?: string[] };

async function typeLine(page: Page, line: string): Promise<void> {
  await page.locator('.xterm-screen').click();
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe('TEXTAREA');
  await page.keyboard.type(line, { delay: 20 });
  await page.keyboard.press('Enter');
}

async function hostFakeAgent(page: Page, repo: string): Promise<void> {
  await typeLine(page, `cd ${shellQuote(repo)}; fake-agent`);
  await expect(page.locator('.xterm-rows')).toContainText(FAKE_AGENT_READY);
}

async function expandCard(controller: Page, repo: string) {
  const card = cardLocator(controller, repo);
  const header = cardHeaderLocator(card, repo);
  await expect(header).toBeVisible({ timeout: STATUS_BUDGET_MS });
  if (await header.getAttribute('aria-expanded') !== 'true') await header.click();
  return card;
}

const workingShown = async (controller: Page): Promise<string[]> =>
  unshownCounts((await windowHeaderLocator(controller).allTextContents()).join(' '), [['working', 1]]);

test('a quiet agent with a command running reads Waiting on its card and counts as working, then Idle once the command ends, while its helpers never count', { tag: '@ownapp' }, async () => {
  test.setTimeout(240_000);
  const h = await createControllerDesktopHarness();
  const binDir = mkdtempSync(join(tmpdir(), 'waiting-agent-'));
  const repo = h.fixture.repositories[0];
  try {
    seedFakeAgentSteps(binDir, {});
    mkdirSync(join(repo, '.agent-terminal'), { recursive: true });
    seedTrustedFlow(h.fixture.home, repo, 'waiting-tracer', autoGateFlowYaml([{ id: 'implement', kind: 'manual' }], 'waiting-tracer'));
    writeFileSync(join(repo, '.agent-terminal', 'flow-state.yaml'), 'step: implement\nstatus: not_started\n');
    const controller = await h.launch(controllerTarget, h.fixture.nonGit);
    const terminal = await h.launch(terminalTarget, repo, { env: { PATH: `${binDir}:${h.fixture.env.PATH ?? process.env.PATH}`, ...SLOW_LOOKUP_ENV } });
    await hostFakeAgent(terminal.page, repo);
    const control = terminal.page.locator('#flow-strip .flow-control');
    await control.click();
    await expect(control).toHaveText('Advance');
    for (const [name, group] of [['caffeinate', 'agent'], ['codex-code-mode-host', 'own'], [COMMAND, 'session']] as const) {
      await typeLine(terminal.page, fakeSpawnLine(name, group));
      await fakeProcessPid(binDir, name);
    }
    const card = await expandCard(controller.page, repo);

    await expect.soft(statusRowLocator(card)).toHaveText(`Waiting · ${COMMAND}`, { timeout: STATUS_BUDGET_MS });
    await expect.soft.poll(() => workingShown(controller.page), { timeout: STATUS_BUDGET_MS }).toEqual([]);
    await expect.soft(timelineEntriesLocator(card).first()).toHaveText(/\bWorking\b/, { timeout: STATUS_BUDGET_MS });

    const entriesBefore = await timelineEntriesLocator(card).allInnerTexts();
    await controller.page.evaluate(directory => {
      const seen: string[] = [];
      (window as RecordingWindow).waitingActivities = seen;
      window.controller.subscribeTerminals(items => {
        const activity = items.find(item => item.launchDirectory === directory)?.work?.activity;
        if (activity && seen.at(-1) !== activity) seen.push(activity);
      });
    }, repo);
    await typeLine(terminal.page, 'screen-change');
    const fromWorking = async () => {
      const seen = await controller.page.evaluate(() => (window as RecordingWindow).waitingActivities ?? []);
      return seen.slice(Math.max(seen.indexOf('active'), 0));
    };
    await expect.soft.poll(async () => ({ shown: await fromWorking(), entries: await timelineEntriesLocator(card).allInnerTexts() }), { timeout: STATUS_BUDGET_MS })
      .toEqual({ shown: ['active', 'waiting'], entries: entriesBefore });

    await stopFakeProcess(binDir, COMMAND);
    await expect.soft(statusRowLocator(card)).toHaveText('Idle', { timeout: STATUS_BUDGET_MS });
    await expect.soft(timelineEntriesLocator(card).first()).toHaveText(/\bIdle\b/, { timeout: STATUS_BUDGET_MS });
    expect.soft({ caffeinate: fakeProcessRunning(binDir, 'caffeinate'), codeModeHost: fakeProcessRunning(binDir, 'codex-code-mode-host') })
      .toEqual({ caffeinate: true, codeModeHost: true });
  } finally {
    try { await stopAllFakeProcesses(binDir); }
    finally {
      try { await h.dispose(); }
      finally { rmSync(binDir, { recursive: true, force: true }); }
    }
  }
});

test('with Waiting showing before Start, Start still injects the turn and the turn still stalls at the watchdog limit', { tag: '@ownapp' }, async () => {
  test.setTimeout(240_000);
  const h = await createControllerDesktopHarness();
  const repo = seedAutoGateRepo('waiting-loop-', 'red');
  const tools = seedFakeGhGit('waiting-loop-tools-', { realCommitOps: true });
  try {
    seedTrustedFlow(h.fixture.home, repo, 'waiting-loop', autoGateFlowYaml([
      { id: 'red', kind: 'loop', loop: 'red-loop', authority: 'auto' }, { id: 'verify', kind: 'manual' },
    ], 'waiting-loop'));
    seedFakeAgentV2(tools.binDir, {
      stepId: 'red', artifactRel: '.agent-terminal/loop/artifacts/red-result.json', work: 'noop', roster: loopRoster('red-loop'), logInjected: true,
    });
    const controller = await h.launch(controllerTarget, h.fixture.nonGit);
    const terminal = await h.launch(terminalTarget, repo, { env: {
      PATH: `${tools.binDir}:${h.fixture.env.PATH ?? process.env.PATH}`, FAKE_GHGIT_LOG: tools.logFile,
      CLAUDE_CONFIG_DIR: exampleConfigDir, APP_SUBMIT_DELAY_MS: '100', APP_TURN_TIMEOUT_MS: '8000', ...SLOW_LOOKUP_ENV,
    } });
    await hostFakeAgent(terminal.page, repo);
    const control = terminal.page.locator('#flow-strip .flow-control');
    await expect(control).toHaveText('Start');
    await typeLine(terminal.page, fakeSpawnLine(COMMAND, 'session'));
    await fakeProcessPid(tools.binDir, COMMAND);
    const card = await expandCard(controller.page, repo);
    await expect.soft(statusRowLocator(card)).toHaveText('Unassigned', { timeout: STATUS_BUDGET_MS });
    await expect.soft(card).toContainText(`Waiting · ${COMMAND}`, { timeout: STATUS_BUDGET_MS });

    await control.click();
    const injected = () => { try { return readFileSync(join(repo, '.agent-terminal', 'injected-log'), 'utf8'); } catch { return ''; } };
    await expect.poll(injected, { timeout: STATUS_BUDGET_MS }).toContain('turn-done:work-red');
    const stalled = () => terminal.page.evaluate(directory => window.flow.state(directory).then(view => view.loop?.stalled === true), repo);
    await expect.poll(stalled, { timeout: 120_000 }).toBe(true);
    expect(fakeProcessRunning(tools.binDir, COMMAND)).toBe(true);
  } finally {
    try { await stopAllFakeProcesses(tools.binDir); }
    finally {
      try { await h.dispose(); }
      finally {
        rmSync(repo, { recursive: true, force: true });
        rmSync(tools.binDir, { recursive: true, force: true });
      }
    }
  }
});
