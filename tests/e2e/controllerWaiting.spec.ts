import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createControllerDesktopHarness } from './controllerDesktop';
import { STATUS_BUDGET_MS } from './controllerStatusObservation';
import { autoGateFlowYaml, loopRoster, seedAutoGateRepo, seedTrustedFlow } from './autoGateHarness';
import { exampleConfigDir, FAKE_AGENT_READY, seedFakeAgentSteps, seedFakeAgentV2, seedFakeGhGit } from './fakeTools';
import { fakeProcessPid, fakeProcessRunning, fakeSpawnLine, stopAllFakeProcesses, stopFakeProcess } from './fakeProcesses';
import { cardHeaderLocator, cardLocator, statusRowLocator, timelineEntriesLocator, unshownCounts, windowHeaderLocator } from '../helpers/controllerCards';
import { shellQuote } from '../../src/shared/shellQuote';
import { PS_ARGS } from '../../src/main/waitingLookup';

const terminalTarget = { kind: 'development' as const, entry: resolve('out/main/index.js') };
const controllerTarget = { kind: 'development' as const, entry: resolve('out/main/controller.js') };
const COMMAND = 'fake-suite';
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
    const card = await expandCard(controller.page, repo);
    await expect(statusRowLocator(card)).toHaveText('Idle', { timeout: STATUS_BUDGET_MS });
    for (const [name, group] of [['caffeinate', 'agent'], ['codex-code-mode-host', 'own'], [COMMAND, 'session']] as const) {
      await typeLine(terminal.page, fakeSpawnLine(name, group));
      await fakeProcessPid(binDir, name);
    }

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

type ShownActivity = { agentState: string; program: string | null };
type MonitorRecordingWindow = Window & { monitorUpdates?: ShownActivity[]; flowViews?: ShownActivity[] };

test('the status strip and the flow strip read Waiting with the program label while a command runs, and their quiet display once it ends', { tag: '@ownapp' }, async () => {
  test.setTimeout(240_000);
  const h = await createControllerDesktopHarness();
  const binDir = mkdtempSync(join(tmpdir(), 'waiting-window-'));
  const repo = h.fixture.repositories[0];
  try {
    seedFakeAgentSteps(binDir, {});
    mkdirSync(join(repo, '.agent-terminal'), { recursive: true });
    seedTrustedFlow(h.fixture.home, repo, 'waiting-window', autoGateFlowYaml([{ id: 'implement', kind: 'manual' }], 'waiting-window'));
    writeFileSync(join(repo, '.agent-terminal', 'flow-state.yaml'), 'step: implement\nstatus: not_started\n');
    await h.launch(controllerTarget, h.fixture.nonGit);
    const { page } = await h.launch(terminalTarget, repo, { env: { PATH: `${binDir}:${h.fixture.env.PATH ?? process.env.PATH}`, ...SLOW_LOOKUP_ENV } });
    await hostFakeAgent(page, repo);
    const control = page.locator('#flow-strip .flow-control');
    await control.click();
    await expect(control).toHaveText('Advance');
    const agentChip = page.locator('#monitor-status').getByText(/^agent:/);
    const derivedLine = page.locator('#flow-strip').getByText(/^\d+ \/ \d+ done\b/);
    await expect(agentChip).toContainText('quiet', { timeout: STATUS_BUDGET_MS });
    await expect(derivedLine).toContainText('quiet', { timeout: STATUS_BUDGET_MS });
    const quietDerivedLine = await derivedLine.innerText();
    await page.evaluate(directory => {
      const seen: ShownActivity[] = [];
      const views: ShownActivity[] = [];
      (window as MonitorRecordingWindow).monitorUpdates = seen;
      (window as MonitorRecordingWindow).flowViews = views;
      window.monitor.onUpdate(msg => seen.push({ agentState: msg.agentState, program: msg.waiting?.program ?? null }));
      window.flow.onStateChanged(() => {
        void window.flow.state(directory).then(view => {
          if (view.derived) views.push({ agentState: view.derived.activity, program: view.derived.waiting?.program ?? null });
        }, () => {});
      });
    }, repo);

    await typeLine(page, fakeSpawnLine(COMMAND, 'session'));
    await fakeProcessPid(binDir, COMMAND);
    const shownWaiting = new RegExp(String.raw`\b(?:waiting|Waiting|WAITING)\b.*\b${COMMAND}\b`);
    await expect.soft(agentChip).toHaveText(shownWaiting, { timeout: STATUS_BUDGET_MS });
    await expect.soft(derivedLine).toHaveText(shownWaiting, { timeout: STATUS_BUDGET_MS });

    const updates = () => page.evaluate(() => (window as MonitorRecordingWindow).monitorUpdates ?? []);
    const flowViews = () => page.evaluate(() => (window as MonitorRecordingWindow).flowViews ?? []);
    const beforeFlip = { updates: (await updates()).length, views: (await flowViews()).length };
    await typeLine(page, 'screen-change');
    const afterFlip = (seen: ShownActivity[]) => ({
      sawActive: seen.some(shown => shown.agentState === 'active'),
      activeCarryingWaiting: seen.filter(shown => shown.agentState === 'active' && shown.program !== null),
      latest: seen.at(-1) ?? null,
    });
    const flipOutcome = { activeCarryingWaiting: [], latest: { agentState: 'quiet', program: COMMAND } };
    await expect.soft.poll(async () => {
      const { sawActive: _pulledInTime, ...views } = afterFlip((await flowViews()).slice(beforeFlip.views));
      return { monitorUpdates: afterFlip((await updates()).slice(beforeFlip.updates)), flowViews: views };
    }, { timeout: STATUS_BUDGET_MS }).toEqual({ monitorUpdates: { sawActive: true, ...flipOutcome }, flowViews: flipOutcome });

    await stopFakeProcess(binDir, COMMAND);
    await expect.soft.poll(async () => ({
      agentChip: await agentChip.innerText(),
      derivedLine: await derivedLine.innerText(),
      sawWaiting: (await updates()).some(update => update.program === COMMAND),
    }), { timeout: STATUS_BUDGET_MS }).toEqual({
      agentChip: expect.stringMatching(/^agent: quiet for \d+s$/),
      derivedLine: quietDerivedLine,
      sawWaiting: true,
    });
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

test('naming a running helper in the operator\'s helper file makes a terminal Waiting only because of it read Idle, with no restart', { tag: '@ownapp' }, async () => {
  test.setTimeout(240_000);
  const h = await createControllerDesktopHarness();
  const binDir = mkdtempSync(join(tmpdir(), 'waiting-helper-file-'));
  const repo = h.fixture.repositories[0];
  const helper = 'my-lsp';
  try {
    seedFakeAgentSteps(binDir, {});
    mkdirSync(join(repo, '.agent-terminal'), { recursive: true });
    seedTrustedFlow(h.fixture.home, repo, 'waiting-helper-file', autoGateFlowYaml([{ id: 'implement', kind: 'manual' }], 'waiting-helper-file'));
    writeFileSync(join(repo, '.agent-terminal', 'flow-state.yaml'), 'step: implement\nstatus: not_started\n');
    const controller = await h.launch(controllerTarget, h.fixture.nonGit);
    const terminal = await h.launch(terminalTarget, repo, { env: { PATH: `${binDir}:${h.fixture.env.PATH ?? process.env.PATH}`, ...SLOW_LOOKUP_ENV } });
    await hostFakeAgent(terminal.page, repo);
    const control = terminal.page.locator('#flow-strip .flow-control');
    await control.click();
    await expect(control).toHaveText('Advance');
    const card = await expandCard(controller.page, repo);
    await typeLine(terminal.page, fakeSpawnLine(helper, 'session'));
    await fakeProcessPid(binDir, helper);
    await expect(statusRowLocator(card)).toHaveText(`Waiting · ${helper}`, { timeout: STATUS_BUDGET_MS });

    mkdirSync(join(h.fixture.home, '.agent-terminal'), { recursive: true });
    writeFileSync(join(h.fixture.home, '.agent-terminal', 'helper-programs.yaml'), `- ${helper}\n`);
    await expect.soft(statusRowLocator(card)).toHaveText('Idle', { timeout: STATUS_BUDGET_MS });
    expect.soft(fakeProcessRunning(binDir, helper)).toBe(true);
  } finally {
    try { await stopAllFakeProcesses(binDir); }
    finally {
      try { await h.dispose(); }
      finally { rmSync(binDir, { recursive: true, force: true }); }
    }
  }
});

test('a lookup slower than the default bound still finds a command when APP_WAITING_LOOKUP_TIMEOUT_MS allows it', { tag: '@ownapp' }, async () => {
  test.setTimeout(240_000);
  const h = await createControllerDesktopHarness();
  const binDir = mkdtempSync(join(tmpdir(), 'waiting-bound-'));
  const shimDir = mkdtempSync(join(tmpdir(), 'waiting-slow-ps-'));
  const repo = h.fixture.repositories[0];
  try {
    seedFakeAgentSteps(binDir, {});
    const realPs = execFileSync('sh', ['-c', 'command -v ps'], { encoding: 'utf8' }).trim();
    writeFileSync(join(shimDir, 'ps'), `#!/bin/sh\n[ "$*" = ${shellQuote(PS_ARGS.join(' '))} ] && sleep 3\nexec ${shellQuote(realPs)} "$@"\n`);
    chmodSync(join(shimDir, 'ps'), 0o755);
    await h.launch(controllerTarget, h.fixture.nonGit);
    const { page } = await h.launch(terminalTarget, repo, { env: { PATH: `${shimDir}:${binDir}:${h.fixture.env.PATH ?? process.env.PATH}`, ...SLOW_LOOKUP_ENV } });
    await hostFakeAgent(page, repo);
    await typeLine(page, fakeSpawnLine(COMMAND, 'session'));
    await fakeProcessPid(binDir, COMMAND);
    await expect(page.locator('#monitor-status').getByText(/^agent:/)).toHaveText(new RegExp(String.raw`\bwaiting\b.*\b${COMMAND}\b`), { timeout: STATUS_BUDGET_MS });
  } finally {
    try { await stopAllFakeProcesses(binDir); }
    finally {
      try { await h.dispose(); }
      finally {
        rmSync(binDir, { recursive: true, force: true });
        rmSync(shimDir, { recursive: true, force: true });
      }
    }
  }
});
