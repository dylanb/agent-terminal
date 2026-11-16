import { controllerOf, electron } from './registeredElectron';
/// <reference lib="dom" />
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dump, load } from 'js-yaml';
import { WINDOW_TIMEOUT_MS } from '../helpers/e2eBudget';
import { shellQuote } from '../../src/shared/shellQuote';
import { decisionProblemText } from '../../src/shared/flowBranch';
import { decidingAgent, exampleConfigDir, goalDecidingAgent, seedDecisionConfig, seedFakeAgentV2, seedFakeGhGit, seedGoalDecisionConfig, seedV3GoalAgent } from './fakeTools';
import { gateDecisionDecider, gateDecisionKind, parseAutoHaltReasons } from '../../src/shared/audit';
import { auditDecisionEvents, auditGateEntries, autoGateFlowYaml, loopRoster, seedAutoGateRepo, seedTrustedFlow, type AutoGateStep } from './autoGateHarness';

const FIRST_PAINT_MS = 15_000;
const UI_MS = 10_000;
const LOOP_ROUND_MS = 60_000;
const APPROVE_ADVANCE_MS = 30_000;

let app: ElectronApplication | undefined;
let page: Page;
const cleanup: string[] = [];

test.afterEach(async () => {
  await app?.close();
  app = undefined;
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tmp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
};

async function typeCommand(cmd: string): Promise<void> {
  await page.locator('.xterm-screen').click();
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe('TEXTAREA');
  await page.keyboard.type(cmd, { delay: 20 });
  await page.keyboard.press('Enter');
}

const flowControl = () => page.locator('#flow-strip .flow-control');
const header = () => page.locator('#flow-strip .sect');
const stationNames = () => page.locator('#flow-strip .flow.vert .stn .nm');
const station = (name: string) => page.locator('#flow-strip .flow.vert .stn', { has: page.locator('.nm', { hasText: name }) });
const runState = (repo: string): string => {
  const file = join(repo, '.agent-terminal', 'loop', 'run-state.yaml');
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
};

const BRANCHED_STEPS: AutoGateStep[] = [
  { id: 'triage', kind: 'loop', loop: 'groom-loop', authority: 'human', decides: ['a', 'b'] },
  { id: 'a1', kind: 'manual', when: { step: 'triage', value: 'a' } },
  { id: 'b1', kind: 'manual', when: { step: 'triage', value: 'b' } },
  { id: 'b2', kind: 'manual', when: { step: 'triage', value: 'b' } },
  { id: 'wrap', kind: 'manual' },
];

test('a branched flow hides its undecided steps and shows no step count', { tag: '@ownapp' }, async () => {
  test.setTimeout(WINDOW_TIMEOUT_MS + FIRST_PAINT_MS + 4 * UI_MS);
  const home = tmp('agent-term-e2e-branch-home-');
  const repo = seedAutoGateRepo('agent-term-e2e-branch-', 'triage', { ticket: '176' });
  cleanup.push(repo);
  seedTrustedFlow(home, repo, 'branched', autoGateFlowYaml(BRANCHED_STEPS, 'branched'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-branch-bin-', { realCommitOps: true });
  cleanup.push(binDir);
  seedFakeAgentV2(binDir, {
    stepId: 'triage',
    artifactRel: '.agent-terminal/loop/artifacts/groomed-ticket.md',
    work: 'complete',
    roster: loopRoster('groom-loop'),
  });
  app = await electron.launch({
    args: ['out/main/index.js', `--user-data-dir=${tmp('agent-term-e2e-branch-ud-')}`],
    env: {
      ...process.env,
      APP_SHELL: 'bash',
      HOME: home,
      APP_SUBMIT_DELAY_MS: '100',
      CLAUDE_CONFIG_DIR: exampleConfigDir,
      PATH: `${binDir}:${process.env.PATH}`,
      FAKE_GHGIT_LOG: logFile,
    },
  });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(page.locator('.xterm-rows')).not.toHaveText('', { timeout: FIRST_PAINT_MS });
  await typeCommand(`cd ${shellQuote(repo)}`);
  await expect(flowControl()).toHaveText('Start', { timeout: UI_MS });
  await typeCommand('fake-agent');

  await flowControl().click();

  await expect(stationNames()).toHaveText(['Not started', 'Triage', 'next steps depend on the verdict', 'Wrap', 'Completed'], { timeout: UI_MS });
  await expect(header()).not.toHaveText(/\d+ \/ \d+/);
});

interface DecidingRun {
  prefix: string;
  home: string;
  repo: string;
  config: string;
  binDir: string;
  logFile: string;
}

async function launchDeciding(run: DecidingRun, control: 'Start' | 'Advance' | 'Restart'): Promise<void> {
  app = await electron.launch({
    args: ['out/main/index.js', `--user-data-dir=${tmp(`${run.prefix}ud-`)}`],
    env: {
      ...process.env,
      APP_SHELL: 'bash',
      HOME: run.home,
      APP_SUBMIT_DELAY_MS: '100',
      CLAUDE_CONFIG_DIR: run.config,
      PATH: `${run.binDir}:${process.env.PATH}`,
      FAKE_GHGIT_LOG: run.logFile,
    },
  });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(page.locator('.xterm-rows')).not.toHaveText('', { timeout: FIRST_PAINT_MS });
  await typeCommand(`cd ${shellQuote(run.repo)}`);
  await expect(flowControl()).toHaveText(control, { timeout: UI_MS });
  await typeCommand('fake-agent');
}

async function startDeciding(prefix: string, value: string, steps: AutoGateStep[], configure?: (config: string) => void): Promise<DecidingRun> {
  const home = tmp(`${prefix}home-`);
  const repo = seedAutoGateRepo(prefix, 'triage', { ticket: '176' });
  cleanup.push(repo);
  seedTrustedFlow(home, repo, 'branched', autoGateFlowYaml(steps, 'branched'));
  const config = seedDecisionConfig(`${prefix}config-`);
  cleanup.push(config);
  configure?.(config);
  const { binDir, logFile } = seedFakeGhGit(`${prefix}bin-`, { realCommitOps: true });
  cleanup.push(binDir);
  seedFakeAgentV2(binDir, decidingAgent(value));
  const run = { prefix, home, repo, config, binDir, logFile };
  await launchDeciding(run, 'Start');
  await flowControl().click();
  return run;
}

async function openLoopPanel(): Promise<void> {
  const readout = page.locator('#flow-strip .loopstat');
  if ((await readout.getAttribute('aria-expanded')) !== 'true') await readout.click();
}

async function approveAtGate(): Promise<void> {
  await openLoopPanel();
  const approve = page.locator('#loop-panel [data-gate-option="approve"]');
  await expect(approve).toBeVisible({ timeout: UI_MS });
  await approve.click();
}

async function approveDecision(prefix: string, value: string, steps: AutoGateStep[] = BRANCHED_STEPS, configure?: (config: string) => void): Promise<DecidingRun> {
  const started = await startDeciding(prefix, value, steps, configure);
  await expect.poll(() => runState(started.repo), { timeout: LOOP_ROUND_MS }).toContain('verdict: clean');
  await approveAtGate();
  return started;
}

test('approving a deciding step shows only the chosen path', { tag: '@ownapp' }, async () => {
  test.setTimeout(2 * (WINDOW_TIMEOUT_MS + FIRST_PAINT_MS) + LOOP_ROUND_MS + APPROVE_ADVANCE_MS + 6 * UI_MS);
  const run = await approveDecision('agent-term-e2e-decide-', 'b');
  const chosenRail = ['Not started', 'Triage', 'B1', 'B2', 'Wrap', 'Completed'];

  await expect(header()).toHaveText('Flow — step 3 / 6', { timeout: APPROVE_ADVANCE_MS });
  await expect(stationNames()).toHaveText(chosenRail);
  await expect(station('Triage').locator('.tag')).toHaveText('b');
  expect(auditDecisionEvents(run.home, run.repo)).toEqual([{ step: 'triage', value: 'b' }]);
  await app?.close();
  app = undefined;

  await launchDeciding(run, 'Advance');

  await expect(header()).toHaveText('Flow — step 3 / 6');
  await expect(stationNames()).toHaveText(chosenRail);
  await expect(station('Triage').locator('.tag')).toHaveText('b');
});

const COMMON_NEXT_STEPS: AutoGateStep[] = [
  { id: 'triage', kind: 'loop', loop: 'groom-loop', authority: 'human', decides: ['a', 'b'] },
  { id: 'common', kind: 'manual' },
  { id: 'a1', kind: 'manual', when: { step: 'triage', value: 'a' } },
  { id: 'b1', kind: 'manual', when: { step: 'triage', value: 'b' } },
];

for (const [layout, steps, chosen] of [
  ['the next step waits on it', BRANCHED_STEPS, /step 3 \/ 6$/],
  ['the next step runs on every path', COMMON_NEXT_STEPS, /step 3 \/ 5$/],
] as const) {
  test(`Advance on a deciding step that has not decided yet says why and leaves the flow put: ${layout}`, { tag: '@ownapp' }, async () => {
    test.setTimeout(WINDOW_TIMEOUT_MS + FIRST_PAINT_MS + LOOP_ROUND_MS + APPROVE_ADVANCE_MS + 4 * UI_MS);
    const run = await startDeciding('agent-term-e2e-advance-undecided-', 'b', [...steps]);
    await expect.poll(() => runState(run.repo), { timeout: LOOP_ROUND_MS }).toContain('verdict: clean');

    await flowControl().click();

    await expect(page.locator('#flow-strip .flow-notice')).toContainText('Triage', { timeout: UI_MS });
    await expect(header()).not.toHaveText(/\d+ \/ \d+/);
    expect(readFileSync(join(run.repo, '.agent-terminal', 'flow-state.yaml'), 'utf8')).toMatch(/^step: triage$/m);

    await approveAtGate();

    await expect(header()).toHaveText(chosen, { timeout: APPROVE_ADVANCE_MS });
  });
}

test('an undeclared decision value is refused at approve and the flow stays put', { tag: '@ownapp' }, async () => {
  test.setTimeout(WINDOW_TIMEOUT_MS + FIRST_PAINT_MS + LOOP_ROUND_MS + APPROVE_ADVANCE_MS + 4 * UI_MS);
  const { home, repo } = await approveDecision('agent-term-e2e-undeclared-', 'c');

  await expect.poll(() => controllerOf(app!).loopMessage(), { timeout: APPROVE_ADVANCE_MS }).toMatchObject({ kind: 'error', reason: decisionProblemText('undeclared-value') });
  await expect(header()).not.toHaveText(/\d+ \/ \d+/);
  await expect(stationNames()).toHaveText(['Not started', 'Triage', 'next steps depend on the verdict', 'Wrap', 'Completed']);
  expect(runState(repo)).toContain('status: complete');
  expect(readFileSync(join(repo, '.agent-terminal', 'flow-state.yaml'), 'utf8')).not.toMatch(/^decisions:/m);
  expect(auditDecisionEvents(home, repo)).toEqual([]);
});

const PICKUP_ON_A_STEPS: AutoGateStep[] = [
  { id: 'triage', kind: 'loop', loop: 'groom-loop', authority: 'human', decides: ['a', 'b'] },
  { id: 'a1', kind: 'loop', loop: 'plan-approve-loop', when: { step: 'triage', value: 'a' } },
  { id: 'b1', kind: 'manual', when: { step: 'triage', value: 'b' } },
  { id: 'wrap', kind: 'manual' },
];

const givePickup = (loop: string) => (config: string): void => {
  const defPath = join(config, 'loops-v2', loop, `${loop}.yaml`);
  const def = load(readFileSync(defPath, 'utf8')) as Record<string, unknown>;
  def.pickup = { initial_status: 'planning', branch_template: 'plan-loop/issue-{issue}' };
  writeFileSync(defPath, dump(def));
};

test('a relaunch on the path not taken is not held for a pickup that only the other path runs', { tag: '@ownapp' }, async () => {
  test.setTimeout(2 * (WINDOW_TIMEOUT_MS + FIRST_PAINT_MS) + LOOP_ROUND_MS + APPROVE_ADVANCE_MS + 6 * UI_MS);
  const run = await approveDecision('agent-term-e2e-pickup-other-path-', 'b', PICKUP_ON_A_STEPS, givePickup('plan-approve-loop'));
  await expect(header()).toHaveText('Flow — step 3 / 5', { timeout: APPROVE_ADVANCE_MS });
  await app?.close();
  app = undefined;

  await launchDeciding(run, 'Advance');
  await flowControl().click();

  await expect(header()).toHaveText('Flow — step 4 / 5', { timeout: UI_MS });
  await expect(page.getByRole('alertdialog').filter({ hasText: 'ticket and pull request' })).toHaveCount(0);
});

const AUTO_BRANCHED_STEPS: AutoGateStep[] = BRANCHED_STEPS.map((s) => (s.id === 'triage' ? { ...s, authority: 'auto', haltOnDecision: ['a'] } : s));

test('an auto deciding step takes a non-halting path by itself and halts on a listed value', { tag: '@ownapp' }, async () => {
  test.setTimeout(2 * (WINDOW_TIMEOUT_MS + FIRST_PAINT_MS + LOOP_ROUND_MS + APPROVE_ADVANCE_MS + 4 * UI_MS));
  const taken = await startDeciding('agent-term-e2e-auto-decide-b-', 'b', AUTO_BRANCHED_STEPS);

  await expect(header()).toHaveText('Flow — step 3 / 6', { timeout: LOOP_ROUND_MS + APPROVE_ADVANCE_MS });
  await expect(stationNames()).toHaveText(['Not started', 'Triage', 'B1', 'B2', 'Wrap', 'Completed']);
  await expect(station('Triage').locator('.tag')).toHaveText('b');
  const decided = auditGateEntries(taken.home, taken.repo).filter((e) => gateDecisionKind(e.cmd)?.kind === 'decision');
  expect(decided.map((e) => gateDecisionDecider(e.cmd))).toEqual(['engine']);
  expect(auditDecisionEvents(taken.home, taken.repo)).toEqual([{ step: 'triage', value: 'b' }]);
  await app?.close();
  app = undefined;

  const held = await startDeciding('agent-term-e2e-auto-decide-a-', 'a', AUTO_BRANCHED_STEPS);

  await expect.poll(() => runState(held.repo), { timeout: LOOP_ROUND_MS }).toContain('verdict: clean');
  await openLoopPanel();
  await expect(page.locator('#loop-panel [data-auto-halt-reason="decision-held"]')).toBeVisible({ timeout: APPROVE_ADVANCE_MS });
  await expect(header()).not.toHaveText(/\d+ \/ \d+/);
  expect(runState(held.repo)).toContain('status: complete');
  const halts = auditGateEntries(held.home, held.repo).filter((e) => gateDecisionKind(e.cmd)?.kind === 'auto-halt');
  expect(halts.map((e) => parseAutoHaltReasons(e.cmd))).toEqual([expect.arrayContaining(['decision-held'])]);
  expect(auditDecisionEvents(held.home, held.repo)).toEqual([]);
});

const DECIDING_LAST_STEPS: AutoGateStep[] = [
  { id: 'triage', kind: 'loop', loop: 'groom-loop', authority: 'human', decides: ['a', 'b'] },
  { id: 'a1', kind: 'manual', when: { step: 'triage', value: 'a' } },
];

test('a relaunch keeps the chosen path, undo keeps it, and restart clears it', { tag: '@ownapp' }, async () => {
  test.setTimeout(2 * (WINDOW_TIMEOUT_MS + FIRST_PAINT_MS) + LOOP_ROUND_MS + APPROVE_ADVANCE_MS + 8 * UI_MS);
  const run = await approveDecision('agent-term-e2e-relaunch-decide-', 'b', DECIDING_LAST_STEPS);
  const decidedRail = ['Not started', 'Triage', 'Completed'];
  await expect(header()).toHaveText('Flow — step 3 / 3', { timeout: APPROVE_ADVANCE_MS });
  await expect(stationNames()).toHaveText(decidedRail);
  await app?.close();
  app = undefined;

  await launchDeciding(run, 'Restart');

  await expect(header()).toHaveText('Flow — step 3 / 3');
  await expect(stationNames()).toHaveText(decidedRail);
  await expect(station('Triage').locator('.tag')).toHaveText('b');

  await page.locator('#flow-strip .flow-undo').click();

  await expect(header()).toHaveText('Flow — step 2 / 3', { timeout: UI_MS });
  await expect(stationNames()).toHaveText(decidedRail);
  await expect(station('Triage').locator('.tag')).toHaveText('b');
  await expect(flowControl()).toHaveText('Advance');

  await flowControl().click();

  await expect(header()).toHaveText('Flow — step 3 / 3', { timeout: UI_MS });
  await expect(flowControl()).toHaveText('Restart');

  await flowControl().click();

  await expect(stationNames()).toHaveText(['Not started', 'Triage', 'next steps depend on the verdict', 'Completed'], { timeout: UI_MS });
  await expect(header()).not.toHaveText(/\d+ \/ \d+/);
  await expect(station('Triage').locator('.tag')).toHaveCount(0);
  expect(auditDecisionEvents(run.home, run.repo)).toEqual([{ step: 'triage', value: 'b' }]);
});

test('a deciding goal session is told where its decision goes and its check passes', { tag: '@ownapp' }, async () => {
  test.setTimeout(WINDOW_TIMEOUT_MS + FIRST_PAINT_MS + LOOP_ROUND_MS + 4 * UI_MS);
  const prefix = 'agent-term-e2e-goal-decide-';
  const home = tmp(`${prefix}home-`);
  const repo = seedAutoGateRepo(prefix, 'triage', { ticket: '176' });
  cleanup.push(repo);
  const steps: AutoGateStep[] = [
    { id: 'triage', kind: 'loop', loop: 'groom-goal-loop', authority: 'human', decides: ['heron', 'osprey'] },
    { id: 'a1', kind: 'manual', when: { step: 'triage', value: 'heron' } },
    { id: 'b1', kind: 'manual', when: { step: 'triage', value: 'osprey' } },
    { id: 'wrap', kind: 'manual' },
  ];
  seedTrustedFlow(home, repo, 'branched', autoGateFlowYaml(steps, 'branched'));
  const config = seedGoalDecisionConfig(`${prefix}config-`);
  cleanup.push(config);
  const { binDir, logFile } = seedFakeGhGit(`${prefix}bin-`, { realCommitOps: true });
  cleanup.push(binDir);
  seedV3GoalAgent(binDir, 'fake-agent', { triage: goalDecidingAgent('heron') });
  await launchDeciding({ prefix, home, repo, config, binDir, logFile }, 'Start');
  await flowControl().click();

  const promptFile = join(repo, '.agent-terminal', 'goal-prompt.triage.1.md');
  const checkerLog = join(repo, '.agent-terminal', 'checker-log');
  const checksSeen = join(repo, '.agent-terminal', 'checks-seen');
  const lines = (file: string, pattern: RegExp): number => (existsSync(file) ? (readFileSync(file, 'utf8').match(pattern) ?? []).length : 0);
  await expect.poll(() => lines(checksSeen, /^.+$/gm) > 0 && lines(checkerLog, /^exit=/gm) === lines(checksSeen, /^.+$/gm), { timeout: LOOP_ROUND_MS }).toBe(true);
  const decisionRel = '.agent-terminal/loop/artifacts/verdict.json';
  const prompt = readFileSync(promptFile, 'utf8');
  expect(prompt).toContain(decisionRel);
  expect(prompt).toContain('heron');
  expect(prompt).toContain('osprey');
  const decisionChecks = readFileSync(checksSeen, 'utf8').split('\n').filter((l) => /\bdecision\b/.test(l) && l.includes(decisionRel));
  expect(decisionChecks.length).toBeGreaterThan(0);
  expect(readFileSync(checkerLog, 'utf8')).not.toMatch(/exit=[1-9]/);
});
