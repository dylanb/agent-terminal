import { electron } from './registeredElectron';
/// <reference lib="dom" />
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { stopApp } from './stopApp';
import { WINDOW_TIMEOUT_MS } from '../helpers/e2eBudget';
import { shellQuote } from '../../src/shared/shellQuote';
import { seedFakeAgentSteps, seedFakeGhGit, type StepScript } from './fakeTools';
import { auditGateEntries, auditStepSequence, seedAutoGateRepo, seedTrustedFlow } from './autoGateHarness';
import { gateDecisionDecider, gateDecisionKind } from '../../src/shared/audit';
import { NO_STEPS_JSON, STEPS_JSON, injectedLog, repeatListAgent, repeatListFlowYaml, repeatListTitles, seedRepeatListConfig } from './repeatListFixture';

const FIRST_PAINT_MS = 15_000;
const UI_MS = 10_000;
const LOOP_TURN_MS = 60_000;

let app: ElectronApplication | undefined;
let page: Page;
const cleanup: string[] = [];

test.afterEach(async ({}, testInfo) => {
  await stopApp(app, testInfo);
  app = undefined;
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tmp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
};
const flowState = (repo: string): string => {
  const file = join(repo, '.agent-terminal', 'flow-state.yaml');
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
};
const stepSequence = (home: string, repo: string): string[] | string => {
  try {
    return auditStepSequence(home, repo);
  } catch (e) {
    return `no step sequence: ${e instanceof Error ? e.message : String(e)}`;
  }
};

const loadError = () => page.locator('#flow-strip .flow-error');
const startControl = () => page.locator('#flow-strip .flow-control').filter({ hasText: 'Start' });
const loopReadout = () => page.locator('#flow-strip .loopstat');

async function typeCommand(cmd: string): Promise<void> {
  await page.locator('.xterm-screen').click();
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe('TEXTAREA');
  await page.keyboard.type(cmd, { delay: 20 });
  await page.keyboard.press('Enter');
}

function seedRun(prefix: string, flowId: string, yamlText: string): { home: string; repo: string } {
  const home = tmp(`${prefix}home-`);
  const repo = seedAutoGateRepo(prefix, 'design');
  cleanup.push(repo);
  seedTrustedFlow(home, repo, flowId, yamlText);
  return { home, repo };
}

interface Tools {
  config: string;
  binDir: string;
  logFile: string;
}

async function launchInto(prefix: string, home: string, repo: string, agent: Record<string, StepScript> | null, reuse?: Tools): Promise<Tools> {
  const tools = reuse ?? { config: seedRepeatListConfig(), ...seedFakeGhGit(`${prefix}bin-`, { realCommitOps: true }) };
  if (reuse === undefined) cleanup.push(tools.config, tools.binDir);
  const { config, binDir, logFile } = tools;
  if (agent !== null) seedFakeAgentSteps(binDir, agent);
  app = await electron.launch({
    args: ['out/main/index.js', `--user-data-dir=${tmp(`${prefix}ud-`)}`],
    env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100', CLAUDE_CONFIG_DIR: config, PATH: `${binDir}:${process.env.PATH}`, FAKE_GHGIT_LOG: logFile },
  });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(page.locator('.xterm-rows')).not.toHaveText('', { timeout: FIRST_PAINT_MS });
  await typeCommand(`cd ${shellQuote(repo)}`);
  if (agent !== null) await typeCommand('fake-agent');
  await expect(reuse === undefined ? loadError().or(startControl()) : loopReadout()).toBeVisible({ timeout: UI_MS });
  return tools;
}

const ENTRY_LINE = /^entry \d+ of \d+: .*$/m;
const WORK_DONE = /turn-done:(work-[\w-]+)/;

function workTurnEntries(log: string): { turn: string; entry: string | null }[] {
  const turns: { turn: string; entry: string | null }[] = [];
  let prompt: string[] = [];
  for (const line of log.split('\n')) {
    prompt.push(line);
    const done = WORK_DONE.exec(line);
    if (done === null) continue;
    turns.push({ turn: done[1], entry: prompt.find((l) => ENTRY_LINE.test(l)) ?? null });
    prompt = [];
  }
  return turns;
}

function bothKeysYaml(): string {
  const doc = yaml.load(repeatListFlowYaml()) as { name: string; steps: { id: string; repeat?: Record<string, unknown> }[] };
  const repeatStep = doc.steps.find((s) => s.repeat !== undefined);
  if (repeatStep?.repeat === undefined) throw new Error('bothKeysYaml(): the fixture flow has no repeat step');
  repeatStep.repeat.count_input = 'slices';
  return yaml.dump({ ...doc, name: 'repeat-list-both' });
}

function unsourcedYaml(artifact: string): string {
  const doc = yaml.load(repeatListFlowYaml()) as { name: string; steps: { id: string; repeat?: { count_from?: Record<string, unknown> } }[] };
  const countFrom = doc.steps.find((s) => s.repeat?.count_from !== undefined)?.repeat?.count_from;
  if (countFrom === undefined) throw new Error('unsourcedYaml(): the fixture flow has no count_from repeat');
  countFrom.artifact = artifact;
  return yaml.dump({ ...doc, name: 'repeat-list-unsourced' });
}

function humanDesignYaml(): string {
  const doc = yaml.load(repeatListFlowYaml()) as { name: string; steps: { id: string; gate_authority?: string }[] };
  const design = doc.steps.find((s) => s.id === 'design');
  if (design === undefined) throw new Error('humanDesignYaml(): the fixture flow has no design step');
  design.gate_authority = 'human';
  return yaml.dump({ ...doc, name: 'repeat-list-human' });
}

test('the count_from fixture flow loads, and runs its group once when its design writes no list', { tag: '@ownapp' }, async () => {
  test.setTimeout(WINDOW_TIMEOUT_MS + FIRST_PAINT_MS + 3 * UI_MS + 4 * LOOP_TURN_MS);
  const prefix = 'agent-term-e2e-278-once-';
  const { home, repo } = seedRun(prefix, 'repeat-list', repeatListFlowYaml());
  await launchInto(prefix, home, repo, repeatListAgent(repo, { designSource: NO_STEPS_JSON }));

  await expect.soft(loadError()).toHaveCount(0);
  if ((await startControl().count()) === 1) {
    await startControl().click();
    await expect.poll(() => flowState(repo), { timeout: 4 * LOOP_TURN_MS }).toMatch(/^step: done$/m);
  }
  expect(stepSequence(home, repo)).toEqual(['design', 'build', 'check', 'finish', 'done']);
});

test('a repeat declaring both count_input and count_from shows the flow-load error naming the repeat step, and offers no Start', { tag: '@ownapp' }, async () => {
  test.setTimeout(WINDOW_TIMEOUT_MS + FIRST_PAINT_MS + 3 * UI_MS);
  const prefix = 'agent-term-e2e-278-both-';
  const { home, repo } = seedRun(prefix, 'repeat-list-both', bothKeysYaml());
  await launchInto(prefix, home, repo, null);

  await expect.soft(loadError()).toContainText('check', { timeout: UI_MS });
  await expect.soft(startControl()).toHaveCount(0, { timeout: UI_MS });
});

test("a design that writes a 3-entry list runs build and check three times, then finish, then done, each group work turn naming its entry and design's and finish's naming none", { tag: '@ownapp' }, async () => {
  test.setTimeout(WINDOW_TIMEOUT_MS + FIRST_PAINT_MS + 3 * UI_MS + 9 * LOOP_TURN_MS);
  const prefix = 'agent-term-e2e-278-three-';
  const { home, repo } = seedRun(prefix, 'repeat-list', repeatListFlowYaml());
  await launchInto(prefix, home, repo, repeatListAgent(repo, { designSource: STEPS_JSON }));

  await startControl().click();
  await expect.poll(() => flowState(repo), { timeout: 9 * LOOP_TURN_MS }).toMatch(/^step: done$/m);
  expect.soft(stepSequence(home, repo)).toEqual(['design', 'build', 'check', 'build', 'check', 'build', 'check', 'finish', 'done']);
  const titles = repeatListTitles();
  const group = titles.flatMap((title, i) => ['build', 'check'].map((step) => ({ turn: `work-${step}`, entry: `entry ${i + 1} of 3: ${title}` })));
  expect.soft(workTurnEntries(injectedLog(repo))).toEqual([{ turn: 'work-design', entry: null }, ...group, { turn: 'work-finish', entry: null }]);
});

test("a work turn retried after a relaunch names the iteration's entry it was on before the quit", { tag: '@ownapp' }, async () => {
  test.setTimeout(2 * (WINDOW_TIMEOUT_MS + FIRST_PAINT_MS) + 6 * UI_MS + 6 * LOOP_TURN_MS);
  const prefix = 'agent-term-e2e-278-relaunch-';
  const { home, repo } = seedRun(prefix, 'repeat-list', repeatListFlowYaml());
  const sentinel = join(tmp(`${prefix}hold-`), 'hold');
  writeFileSync(sentinel, '');
  const tools = await launchInto(prefix, home, repo, repeatListAgent(repo, { designSource: STEPS_JSON, holdBuild: { sentinel, turn: 2 } }));

  await startControl().click();
  await expect
    .poll(() => workTurnEntries(injectedLog(repo)).filter((t) => t.turn === 'work-build').length, { timeout: 4 * LOOP_TURN_MS })
    .toBe(2);
  const beforeQuit = injectedLog(repo).length;
  writeFileSync(`${sentinel}.abandon`, '');
  await app?.close();
  app = undefined;

  await launchInto(prefix, home, repo, repeatListAgent(repo, { designSource: STEPS_JSON }), tools);
  await loopReadout().click();
  await page.locator('#loop-panel [data-app-route-out="retry"]').click({ timeout: LOOP_TURN_MS });
  await expect
    .poll(() => workTurnEntries(injectedLog(repo, beforeQuit)).map((t) => t.turn), { timeout: LOOP_TURN_MS })
    .toContain('work-build');
  const retried = workTurnEntries(injectedLog(repo, beforeQuit)).find((t) => t.turn === 'work-build');
  expect(retried?.entry).toBe(`entry 2 of 3: ${repeatListTitles()[1]}`);
});

test("a person pressing Approve on design's gate sources the 3-entry list: build and check run three times, each turn naming its entry", { tag: '@ownapp' }, async () => {
  test.setTimeout(WINDOW_TIMEOUT_MS + FIRST_PAINT_MS + 4 * UI_MS + 10 * LOOP_TURN_MS);
  const prefix = 'agent-term-e2e-278-human-';
  const { home, repo } = seedRun(prefix, 'repeat-list-human', humanDesignYaml());
  await launchInto(prefix, home, repo, repeatListAgent(repo, { designSource: STEPS_JSON }));

  await startControl().click();
  const approve = page.locator('#loop-panel [data-gate-option="approve"]');
  await expect(loopReadout()).toBeVisible({ timeout: LOOP_TURN_MS });
  if ((await loopReadout().getAttribute('aria-expanded')) !== 'true') await loopReadout().click();
  await approve.click({ timeout: LOOP_TURN_MS });
  await expect.poll(() => flowState(repo), { timeout: 9 * LOOP_TURN_MS }).toMatch(/^step: done$/m);

  expect(stepSequence(home, repo)).toEqual(['design', 'build', 'check', 'build', 'check', 'build', 'check', 'finish', 'done']);
  const decisions = auditGateEntries(home, repo, { step: 'design' }).filter((e) => gateDecisionKind(e.cmd)?.kind === 'decision');
  expect(decisions.map((e) => gateDecisionDecider(e.cmd))).toEqual(['human']);
  const builds = workTurnEntries(injectedLog(repo)).filter((t) => t.turn === 'work-build');
  expect(builds.map((t) => t.entry)).toEqual(repeatListTitles().map((title, i) => `entry ${i + 1} of 3: ${title}`));
});

test("pressing Start on a flow whose count_from artifact no step's loop outputs leaves it not started, with a notice naming the repeat step and the artifact", { tag: '@ownapp' }, async () => {
  test.setTimeout(WINDOW_TIMEOUT_MS + FIRST_PAINT_MS + 5 * UI_MS);
  const prefix = 'agent-term-e2e-278-unsourced-';
  const { home, repo } = seedRun(prefix, 'repeat-list-unsourced', unsourcedYaml('nowhere'));
  await launchInto(prefix, home, repo, null);

  await startControl().click();
  const notice = page.locator('#flow-strip .flow-notice');
  await expect.soft(notice).toContainText('check', { timeout: UI_MS });
  await expect.soft(notice).toContainText('nowhere');
  await expect.soft(startControl()).toHaveCount(1);
  expect.soft(flowState(repo)).not.toMatch(/^status: in_progress$/m);
});
