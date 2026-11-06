import { electron } from './registeredElectron';
/// <reference lib="dom" />
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { stopApp } from './stopApp';
import { WINDOW_TIMEOUT_MS } from '../helpers/e2eBudget';
import { shellQuote } from '../../src/shared/shellQuote';
import { seedFakeAgentSteps, seedFakeGhGit, type StepScript } from './fakeTools';
import { auditStepSequence, seedAutoGateRepo, seedTrustedFlow } from './autoGateHarness';
import { NO_STEPS_JSON, repeatListAgent, repeatListFlowYaml, seedRepeatListConfig } from './repeatListFixture';

// #278 — a repeat whose count comes from a named list in an artifact (`count_from`), run in the app on the fixture
// flow under tests/fixtures/repeat-list-flow/.

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
/** The steps the run went through, from its §25 record, or why the record cannot be read (no run started). */
const stepSequence = (home: string, repo: string): string[] | string => {
  try {
    return auditStepSequence(home, repo);
  } catch (e) {
    return `no step sequence: ${e instanceof Error ? e.message : String(e)}`;
  }
};

const loadError = () => page.locator('#flow-strip .flow-error');
const startControl = () => page.locator('#flow-strip .flow-control').filter({ hasText: 'Start' });

async function typeCommand(cmd: string): Promise<void> {
  await page.locator('.xterm-screen').click();
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe('TEXTAREA');
  await page.keyboard.type(cmd, { delay: 20 });
  await page.keyboard.press('Enter');
}

/** A repository whose flow is the operator-catalog flow `yamlText`, not started at `design`, and its app home. */
function seedRun(prefix: string, flowId: string, yamlText: string): { home: string; repo: string } {
  const home = tmp(`${prefix}home-`);
  const repo = seedAutoGateRepo(prefix, 'design');
  cleanup.push(repo);
  seedTrustedFlow(home, repo, flowId, yamlText);
  return { home, repo };
}

/** Launches the app on `home` with the fixture's loops in its operator tier and the fake tools first on PATH, then
 *  `cd`s into `repo` and, given a script, hosts the fake agent. */
async function launchInto(prefix: string, home: string, repo: string, agent: Record<string, StepScript> | null): Promise<void> {
  const config = seedRepeatListConfig();
  cleanup.push(config);
  const { binDir, logFile } = seedFakeGhGit(`${prefix}bin-`, { realCommitOps: true });
  cleanup.push(binDir);
  if (agent !== null) seedFakeAgentSteps(binDir, agent);
  app = await electron.launch({
    args: ['out/main/index.js', `--user-data-dir=${tmp(`${prefix}ud-`)}`],
    env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100', CLAUDE_CONFIG_DIR: config, PATH: `${binDir}:${process.env.PATH}`, FAKE_GHGIT_LOG: logFile },
  });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(page.locator('.xterm-rows')).not.toHaveText('', { timeout: FIRST_PAINT_MS });
  await typeCommand(`cd ${shellQuote(repo)}`);
  if (agent !== null) await typeCommand('fake-agent');
  await expect(loadError().or(startControl())).toBeVisible({ timeout: UI_MS });
}

/** The fixture flow with its repeat step also carrying `count_input`, so it declares both count sources. */
function bothKeysYaml(): string {
  const doc = yaml.load(repeatListFlowYaml()) as { name: string; steps: { id: string; repeat?: Record<string, unknown> }[] };
  const repeatStep = doc.steps.find((s) => s.repeat !== undefined);
  if (repeatStep?.repeat === undefined) throw new Error('bothKeysYaml(): the fixture flow has no repeat step');
  repeatStep.repeat.count_input = 'slices';
  return yaml.dump({ ...doc, name: 'repeat-list-both' });
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
