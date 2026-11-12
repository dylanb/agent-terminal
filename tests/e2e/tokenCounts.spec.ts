/// <reference lib="dom" />
import { electron } from './registeredElectron';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WINDOW_TIMEOUT_MS } from '../helpers/e2eBudget';
import { shellQuote } from '../../src/shared/shellQuote';
import { reconstructTimeline } from '../../src/shared/audit';
import { auditFilePath, auditRootDir } from '../../src/main/auditPaths';
import { claudeCodeLogs, type BilledTokens } from '../helpers/agentUsageLogs';
import {
  RUN_TOTAL_ROW,
  panelTokenTableLocator,
  railCountsLocator,
  railRunTotalLocator,
  railTotalLocator,
  showTokenCountsLocator,
  tokenCellLocator,
  tokenTableLocator,
} from '../helpers/tokenCountsUi';
import { agentLogEnv, exampleConfigDir, seedFakeAgentSteps, seedFakeGhGit, type FakeAgentOptions, type FakeBill, type FakeCall, type StepScript } from './fakeTools';
import { autoGateFlowYaml, loopRoster, runIdentity, seedAutoGateRepo, seedTrustedFlow, type AutoGateStep } from './autoGateHarness';

let app: ElectronApplication | undefined;
let userDataDir: string;
const cleanup: string[] = [];

test.beforeEach(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'agent-term-e2e-tokens-ud-'));
});

test.afterEach(async () => {
  await app?.close();
  app = undefined;
  rmSync(userDataDir, { recursive: true, force: true });
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const FIRST_PAINT_MS = 15_000;
const LOOP_ROUND_MS = 60_000;
const STEP_MS = 15_000;
const budget = (launches: number, steps: number, loopRounds = 0): number =>
  launches * (WINDOW_TIMEOUT_MS + FIRST_PAINT_MS) + steps * STEP_MS + loopRounds * LOOP_ROUND_MS;

async function launch(env: Record<string, string> = {}): Promise<Page> {
  app = await electron.launch({
    args: ['out/main/index.js', `--user-data-dir=${userDataDir}`],
    env: { ...process.env, APP_SHELL: 'bash', APP_SUBMIT_DELAY_MS: '100', ...env },
  });
  return app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
}

async function openSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Settings\b/ }).click();
}

test('the setting persists: off on a fresh profile, and still on after a relaunch once turned on', async () => {
  let page = await launch();
  await openSettings(page);
  await expect(showTokenCountsLocator(page, { on: false })).toBeVisible();

  await showTokenCountsLocator(page).click();
  await expect(showTokenCountsLocator(page, { on: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.monitor.getSettings().then((s) => s.showTokenCounts))).toBe(true);

  await app!.close();
  page = await launch();
  await openSettings(page);
  await expect(showTokenCountsLocator(page, { on: true })).toBeVisible();
});

// ---- Counts on the rail (#29) ----

const tmp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
};

interface TokenRig {
  repo: string;
  /** The launch env: the fake agent first on PATH, the app home, and the agents' log roots the fake bills under. */
  env: Record<string, string>;
  /** The path of a Codex from before 0.145.0, when the rig has one: typed in full, since `codex` names the newer. */
  earlierCodex?: string;
}

/** A repo whose trusted flow is `steps` (or `flow.yaml`, whose first step is `steps[0]`), and the fake agent installed
 *  as `claude` billing what `agent` says. With `agents.codex`, it is installed as a Codex 0.145.0+ `codex` too, whose
 *  sessions record `cwd` as their working directory when given, and as an earlier Codex billing
 *  `agents.codex.earlier` when given; without it the machine has no Codex folder at all. */
function tokenRig(
  prefix: string,
  steps: AutoGateStep[],
  scripts: Record<string, StepScript>,
  options: Omit<FakeAgentOptions, 'usage' | 'names'>,
  flow: { ticket?: string; yaml?: string } = {},
  agents: { codex?: { earlier?: Record<string, FakeBill>; cwd?: string } } = {},
): TokenRig {
  const home = tmp(`${prefix}home-`);
  const repo = seedAutoGateRepo(prefix, steps[0].id, flow.ticket === undefined ? {} : { ticket: flow.ticket });
  cleanup.push(repo);
  seedTrustedFlow(home, repo, 'token-flow', flow.yaml ?? autoGateFlowYaml(steps, 'token-flow'));
  const { binDir, logFile } = seedFakeGhGit(`${prefix}bin-`, { realCommitOps: true });
  cleanup.push(binDir);
  const codexHome = agents.codex === undefined ? join(tmp(`${prefix}nocodex-`), 'absent') : tmp(`${prefix}codex-`);
  const usage = { claudeConfigRoot: exampleConfigDir, codexHome, worktree: repo, codexForm: 'cache-write' as const, codexCwd: agents.codex?.cwd };
  seedFakeAgentSteps(binDir, scripts, { ...options, usage, names: agents.codex === undefined ? ['claude'] : ['claude', 'codex'] });
  const env = { HOME: home, PATH: `${binDir}:${process.env.PATH}`, FAKE_GHGIT_LOG: logFile, ...agentLogEnv(usage) };
  if (agents.codex?.earlier === undefined) return { repo, env };
  const earlierBin = tmp(`${prefix}earlier-codex-`);
  seedFakeAgentSteps(earlierBin, {}, { conversation: agents.codex.earlier, usage: { ...usage, codexForm: 'no-cache-write' }, names: ['codex'] });
  return { repo, env, earlierCodex: join(earlierBin, 'codex') };
}

async function typeCommand(page: Page, cmd: string): Promise<void> {
  await page.locator('.xterm-screen').click();
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe('TEXTAREA');
  await page.keyboard.type(cmd, { delay: 20 });
  await page.keyboard.press('Enter');
}

async function setTokenCounts(page: Page, on: boolean): Promise<void> {
  await openSettings(page);
  await showTokenCountsLocator(page, { on: !on }).click();
  await expect(showTokenCountsLocator(page, { on })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.monitor.getSettings().then((s) => s.showTokenCounts))).toBe(on);
  await page.getByRole('button', { name: /^Terminal\b/ }).click();
}

const flowStrip = (page: Page) => page.locator('#flow-strip');
const flowButton = (page: Page, name: string) => flowStrip(page).getByRole('button', { name, exact: true });
const approve = (page: Page) => page.locator('#loop-panel [data-gate-option="approve"]');

/** The rail total of each step, then the run total, as their texts. */
async function expectRail(page: Page, steps: Record<string, string>, run: string): Promise<void> {
  for (const [step, text] of Object.entries(steps)) await expect(railTotalLocator(page, step)).toHaveText(text);
  await expect(railRunTotalLocator(page)).toHaveText(run);
}

type Row = [cacheRead: string, cacheWrite: string, input: string, output: string];
const KINDS = ['cacheRead', 'cacheWrite', 'input', 'output'] as const;
const loopPanel = (page: Page) => page.getByRole('complementary', { name: 'Loop and gate', exact: true });

/** Each named row of the docked panel's token table (a step's name, or RUN_TOTAL_ROW), as its 4 cells' texts. */
async function expectTable(page: Page, rows: Record<string, Row>): Promise<void> {
  const table = tokenTableLocator(loopPanel(page));
  for (const [row, texts] of Object.entries(rows)) {
    for (const [i, kind] of KINDS.entries()) await expect(await tokenCellLocator(table, row, kind)).toHaveText(texts[i]);
  }
}

const DASHES: Row = ['—', '—', '—', '—'];

const call = (cacheRead: number, cacheWrite: number, input: number, output: number, more: Omit<FakeCall, 'tokens'> = {}): FakeCall => ({
  tokens: { cacheRead, cacheWrite, input, output },
  ...more,
});

test('rail counts: off by default, then each station shows its step total, the open step grows while counting, and the status bar shows none', { tag: '@ownapp' }, async () => {
  test.setTimeout(budget(1, 8, 2));
  // Work 44,020, a reviewer subagent 22,010 and the consolidator 10,940: 76,970 in all, shown 77.0k.
  const rig = tokenRig('agent-term-e2e-tokens-rail-', [
    { id: 'red', kind: 'loop', loop: 'red-loop' },
    { id: 'verify', kind: 'manual' },
    { id: 'ship', kind: 'manual' },
  ], {
    red: {
      artifactRel: '.agent-terminal/loop/artifacts/red-result.json',
      work: 'red',
      roster: loopRoster('red-loop'),
      usage: {
        work: [[call(40_000, 3_000, 120, 900, { lines: 3 })]],
        review: [[call(20_000, 1_500, 60, 450, { subagent: 'reviewer-1' })]],
        consolidate: [[call(10_000, 700, 30, 210)]],
      },
    },
  }, { conversation: { 'one more thing': [call(5_000, 200, 15, 80)] } });
  const page = await launch(rig.env);
  await expect(page.locator('.xterm-rows')).not.toHaveText('', { timeout: FIRST_PAINT_MS });
  await typeCommand(page, `cd ${shellQuote(rig.repo)}`);
  await expect(flowButton(page, 'Start')).toBeVisible();
  await typeCommand(page, 'claude');
  await flowButton(page, 'Start').click();
  await expect(flowStrip(page).locator('.spill')).toHaveClass(/\bsettle\b/, { timeout: LOOP_ROUND_MS });
  await flowStrip(page).locator('.loopstat').click();
  await expect(approve(page)).toBeVisible();

  await expect(await railCountsLocator(page, ['red', 'verify', 'ship'])).toHaveCount(0);
  await expect(await panelTokenTableLocator(page)).toHaveCount(0);

  await setTokenCounts(page, true);
  await expectRail(page, { red: '77.0k counting', verify: '—', ship: '—' }, '77.0k');
  await expect(page.locator('#status-bar')).not.toContainText('77.0k');
  await expectTable(page, { red: ['70,000 counting', '5,200 counting', '210 counting', '1,560 counting'] });

  // The operator's own conversation at the gate adds 5,295: 82,265 in all.
  await typeCommand(page, 'one more thing');
  await expectRail(page, { red: '82.3k counting', verify: '—', ship: '—' }, '82.3k');
  await expect(page.locator('#status-bar')).not.toContainText('82.3k');

  await approve(page).click();
  await expectRail(page, { red: '82.3k', verify: '0 counting', ship: '—' }, '82.3k');

  await setTokenCounts(page, false);
  await expect(await railCountsLocator(page, ['red', 'verify', 'ship'])).toHaveCount(0);
  await expect(await panelTokenTableLocator(page)).toHaveCount(0);
});

test('token table: the docked panel shows each step\'s kinds in exact digits, the open row rising live while the gate control keeps focus, and the run total row', { tag: '@ownapp' }, async () => {
  test.setTimeout(budget(1, 6, 1));
  const rig = tokenRig('agent-term-e2e-tokens-table-', [
    { id: 'red', kind: 'loop', loop: 'red-loop' },
    { id: 'verify', kind: 'manual' },
    { id: 'ship', kind: 'manual' },
  ], {
    red: {
      artifactRel: '.agent-terminal/loop/artifacts/red-result.json',
      work: 'red',
      roster: loopRoster('red-loop'),
      usage: { work: [[call(30_000, 2_500, 140, 720)]], consolidate: [[call(9_000, 600, 25, 180)]] },
    },
  }, {});
  const page = await launch(rig.env);
  await expect(page.locator('.xterm-rows')).not.toHaveText('', { timeout: FIRST_PAINT_MS });
  await setTokenCounts(page, true);
  await typeCommand(page, `cd ${shellQuote(rig.repo)}`);
  await expect(flowButton(page, 'Start')).toBeVisible();
  await typeCommand(page, 'claude');
  await flowButton(page, 'Start').click();
  await expect(flowStrip(page).locator('.spill')).toHaveClass(/\bsettle\b/, { timeout: LOOP_ROUND_MS });
  await flowStrip(page).locator('.loopstat').click();

  await expectTable(page, {
    red: ['39,000 counting', '3,100 counting', '165 counting', '900 counting'],
    verify: DASHES,
    ship: DASHES,
    [RUN_TOTAL_ROW]: ['39,000', '3,100', '165', '900'],
  });

  // Spend logged while the step stays at its gate: 1,234,567 more cache reads.
  await approve(page).focus();
  claudeCodeLogs(exampleConfigDir, rig.repo).bill({ at: Date.now(), tokens: { cacheRead: 1_234_567, cacheWrite: 410, input: 12, output: 33 } });
  await expectTable(page, {
    red: ['1,273,567 counting', '3,510 counting', '177 counting', '933 counting'],
    [RUN_TOTAL_ROW]: ['1,273,567', '3,510', '177', '933'],
  });
  await expect(approve(page)).toBeFocused();

  await approve(page).click();
  await expectTable(page, {
    red: ['1,273,567', '3,510', '177', '933'],
    verify: ['0 counting', '0 counting', '0 counting', '0 counting'],
    ship: DASHES,
    [RUN_TOTAL_ROW]: ['1,273,567', '3,510', '177', '933'],
  });
});

// Two manual steps whose spend is the operator's conversation: "bill one" is 12,474 (12.5k), "bill two" 3,259 (3.3k).
const MANUAL_STEPS: AutoGateStep[] = [{ id: 'one', kind: 'manual' }, { id: 'two', kind: 'manual' }];
const CONVERSATION = { 'bill one': [call(12_000, 340, 56, 78)], 'bill two': [call(3_000, 210, 9, 40)] };

/** With `ticket`, step one carries a ticket, so the docked panel can open on these loop-less steps. */
async function launchManual(prefix: string, opts: { ticket?: boolean } = {}): Promise<{ page: Page; rig: TokenRig }> {
  const steps = opts.ticket === true ? [{ ...MANUAL_STEPS[0], ticketInput: true }, MANUAL_STEPS[1]] : MANUAL_STEPS;
  const rig = tokenRig(prefix, steps, {}, { conversation: CONVERSATION }, opts.ticket === true ? { ticket: '29' } : {});
  const page = await launch(rig.env);
  await expect(page.locator('.xterm-rows')).not.toHaveText('', { timeout: FIRST_PAINT_MS });
  await setTokenCounts(page, true);
  await typeCommand(page, `cd ${shellQuote(rig.repo)}`);
  await expect(flowButton(page, 'Start')).toBeVisible();
  await typeCommand(page, 'claude');
  return { page, rig };
}

test('re-runs add up: Undo and Restart add new spend, completion keeps the counts, Terminate shows dashes and a new run counts only its own', { tag: '@ownapp' }, async () => {
  test.setTimeout(budget(1, 14));
  const { page } = await launchManual('agent-term-e2e-tokens-reruns-');
  await expectRail(page, { one: '—', two: '—' }, '—');

  await flowButton(page, 'Start').click();
  await typeCommand(page, 'bill one');
  await expectRail(page, { one: '12.5k counting', two: '—' }, '12.5k');
  await flowButton(page, 'Advance').click();
  await typeCommand(page, 'bill two');
  await expectRail(page, { one: '12.5k', two: '3.3k counting' }, '15.7k');
  await flowButton(page, 'Advance').click();
  await expectRail(page, { one: '12.5k', two: '3.3k' }, '15.7k');

  await flowButton(page, 'Undo').click();
  await typeCommand(page, 'bill two');
  await expectRail(page, { one: '12.5k', two: '6.5k counting' }, '19.0k');
  await flowButton(page, 'Advance').click();
  await flowButton(page, 'Restart').click();
  await typeCommand(page, 'bill one');
  await expectRail(page, { one: '24.9k counting', two: '6.5k' }, '31.5k');

  await flowButton(page, 'Terminate').click();
  await page.locator('#flow-confirm-host .flow-modal .confirm').click();
  await expectRail(page, { one: '—', two: '—' }, '—');

  // The Claude Code still running hosts the new run but has logged nothing since it started.
  await flowButton(page, 'Start').click();
  await expectRail(page, { one: 'unavailable counting', two: '—' }, 'unavailable');
  await typeCommand(page, 'bill one');
  await expectRail(page, { one: '12.5k counting', two: '—' }, '12.5k');
});

test('counts survive a relaunch, with spend logged while the app was closed, and the open step keeps counting', { tag: '@ownapp' }, async () => {
  test.setTimeout(budget(2, 10));
  const { page, rig } = await launchManual('agent-term-e2e-tokens-relaunch-', { ticket: true });
  await flowButton(page, 'Start').click();
  await typeCommand(page, 'bill one');
  await expectRail(page, { one: '12.5k counting', two: '—' }, '12.5k');
  await flowButton(page, 'Advance').click();
  await typeCommand(page, 'bill two');
  await expectRail(page, { one: '12.5k', two: '3.3k counting' }, '15.7k');
  await flowStrip(page).locator('.loopstat').click();
  await expectTable(page, {
    one: ['12,000', '340', '56', '78'],
    two: ['3,000 counting', '210 counting', '9 counting', '40 counting'],
    [RUN_TOTAL_ROW]: ['15,000', '550', '65', '118'],
  });

  await app!.close();
  // Spend the agent logs for step two while the app is closed: 759 more, 4,018 in all (4.0k).
  claudeCodeLogs(exampleConfigDir, rig.repo).bill({ at: Date.now(), tokens: { cacheRead: 700, cacheWrite: 50, input: 3, output: 6 } });
  const relaunched = await launch(rig.env);
  await expect(relaunched.locator('.xterm-rows')).not.toHaveText('', { timeout: FIRST_PAINT_MS });
  await typeCommand(relaunched, `cd ${shellQuote(rig.repo)}`);
  await expectRail(relaunched, { one: '12.5k', two: '4.0k counting' }, '16.5k');
  await flowStrip(relaunched).locator('.loopstat').click();
  await expectTable(relaunched, {
    one: ['12,000', '340', '56', '78'],
    two: ['3,700 counting', '260 counting', '12 counting', '46 counting'],
    [RUN_TOTAL_ROW]: ['15,700', '600', '68', '124'],
  });

  await typeCommand(relaunched, 'claude');
  await typeCommand(relaunched, 'bill two');
  await expectRail(relaunched, { one: '12.5k', two: '7.3k counting' }, '19.8k');
  await expectTable(relaunched, {
    two: ['6,700 counting', '470 counting', '21 counting', '86 counting'],
    [RUN_TOTAL_ROW]: ['18,700', '810', '77', '164'],
  });
});

// ---- The audit record and rollbacks (#29) ----

/** The billed calls the fake has logged for the worktree so far: with the setting off, nothing on screen says so. */
function loggedCalls(dir: string): number {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.jsonl'))
    .reduce((n, name) => n + readFileSync(join(dir, name), 'utf8').split('\n').filter((line) => line !== '').length, 0);
}

const counted = (t: BilledTokens) => ({
  state: 'counted',
  billed: true,
  kinds: {
    cacheRead: { reported: 'all', n: t.cacheRead },
    cacheWrite: { reported: 'all', n: t.cacheWrite },
    input: { reported: 'all', n: t.input },
    output: { reported: 'all', n: t.output },
  },
});

test('audit record keeps final counts: with the setting off, a run terminated at its second step keeps both steps\' counts and their sum', { tag: '@ownapp' }, async () => {
  test.setTimeout(budget(1, 8));
  const rig = tokenRig('agent-term-e2e-tokens-audit-', MANUAL_STEPS, {}, { conversation: CONVERSATION });
  const logs = claudeCodeLogs(exampleConfigDir, rig.repo);
  const page = await launch(rig.env);
  await expect(page.locator('.xterm-rows')).not.toHaveText('', { timeout: FIRST_PAINT_MS });
  await typeCommand(page, `cd ${shellQuote(rig.repo)}`);
  await expect(flowButton(page, 'Start')).toBeVisible();
  await typeCommand(page, 'claude');

  await flowButton(page, 'Start').click();
  await expect(flowButton(page, 'Advance')).toBeVisible();
  await typeCommand(page, 'bill one');
  await expect.poll(() => loggedCalls(logs.dir)).toBe(1);
  await flowButton(page, 'Advance').click();
  await expect.poll(() => readFileSync(join(rig.repo, '.agent-terminal', 'flow-state.yaml'), 'utf8')).toMatch(/^step: two$/m);
  await typeCommand(page, 'bill two');
  await expect.poll(() => loggedCalls(logs.dir)).toBe(2);
  const run = runIdentity(rig.repo);
  await flowButton(page, 'Terminate').click();
  await page.locator('#flow-confirm-host .flow-modal .confirm').click();
  await expect(flowButton(page, 'Start')).toBeVisible();

  const record = auditFilePath(auditRootDir(rig.env.HOME), rig.repo, run.flow, new Date(run.startedAt));
  await expect.poll(() => reconstructTimeline(readFileSync(record, 'utf8')).tokens).toEqual({
    steps: [
      { step: 'one', counts: counted({ cacheRead: 12_000, cacheWrite: 340, input: 56, output: 78 }) },
      { step: 'two', counts: counted({ cacheRead: 3_000, cacheWrite: 210, input: 9, output: 40 }) },
    ],
    run: { state: 'counted', someStepsUnavailable: false, kinds: counted({ cacheRead: 15_000, cacheWrite: 550, input: 65, output: 118 }).kinds },
  });
});

test('rollback keeps the failed step\'s spend: the step rolled back to counts on from its earlier count', { tag: '@ownapp' }, async () => {
  test.setTimeout(budget(1, 12));
  // Step two picks up a ticket; its branch push waits on `hold`, then fails, so the step fails to start and rolls back.
  const rig = tokenRig('agent-term-e2e-tokens-rollback-', MANUAL_STEPS, {}, { conversation: CONVERSATION }, {
    yaml:
      'name: "token-flow"\nsteps:\n  - id: one\n    kind: manual\n' +
      '  - id: two\n    kind: loop\n    loop: plan-loop\n    loop_namespace: app\n' +
      '    inputs:\n      - name: ticket\n        type: github-ticket\n        required: true\n',
  });
  const faults = tmp('agent-term-e2e-tokens-rollback-faults-');
  const hold = join(faults, 'push-hold');
  const pushFail = join(faults, 'push-fail');
  writeFileSync(hold, '');
  writeFileSync(pushFail, '');
  const page = await launch({ ...rig.env, FAKE_GIT_HOLD: hold, FAKE_GIT_HOLD_REV: ':refs/heads/', FAKE_GIT_PUSH_FAIL: pushFail });
  await expect(page.locator('.xterm-rows')).not.toHaveText('', { timeout: FIRST_PAINT_MS });
  await setTokenCounts(page, true);
  await typeCommand(page, `cd ${shellQuote(rig.repo)}`);
  await expect(flowButton(page, 'Start')).toBeVisible();
  await typeCommand(page, 'claude');

  await flowButton(page, 'Start').click();
  await typeCommand(page, 'bill one');
  await expectRail(page, { one: '12.5k counting', two: '—' }, '12.5k');
  await flowButton(page, 'Advance').click();
  const ticket = page.locator('#flow-modal-host .flow-modal');
  await ticket.locator('.field input').fill('29');
  await ticket.locator('.confirm').click();
  await expect.poll(() => (existsSync(rig.env.FAKE_GHGIT_LOG) ? readFileSync(rig.env.FAKE_GHGIT_LOG, 'utf8') : '')).toMatch(/^held /m);
  await typeCommand(page, 'bill two');
  await expectRail(page, { one: '12.5k', two: '3.3k counting' }, '15.7k');

  rmSync(hold);
  const failed = page.locator('#flow-error-host .flow-modal');
  await expect(failed).toBeVisible();
  await failed.locator('.dismiss').click();
  await expectRail(page, { one: '12.5k counting', two: '3.3k' }, '15.7k');
  await typeCommand(page, 'bill one');
  await expectRail(page, { one: '24.9k counting', two: '3.3k' }, '28.2k');
});

// ---- Codex and mixed agents (#29) ----

async function quitAgent(page: Page): Promise<void> {
  await page.locator('.xterm-screen').click();
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe('TEXTAREA');
  await page.keyboard.press('Control+D');
}

/** A call an earlier Codex bills: it logs no cache-write figure. */
const earlier = (cacheRead: number, input: number, output: number): FakeCall => ({ tokens: { cacheRead, input, output } });

test('Codex and mixed agents: a Codex step shows its 4 kinds, an earlier Codex\'s cache writes read not reported, and a step hosting Claude Code then an earlier Codex sums both', { tag: '@ownapp' }, async () => {
  test.setTimeout(budget(1, 18));
  // one: Codex 0.145.0+, 21,930 (21.9k). two: an earlier Codex, 9,400 (9.4k). three: Claude Code 5,540, then an
  // earlier Codex 3,095: 8,635 (8.6k). The run: 39,965 (40.0k).
  const rig = tokenRig(
    'agent-term-e2e-tokens-codex-',
    [{ id: 'one', kind: 'manual', ticketInput: true }, { id: 'two', kind: 'manual' }, { id: 'three', kind: 'manual' }],
    {},
    { conversation: { 'bill codex': [call(20_000, 1_200, 300, 430)], 'bill claude': [call(5_000, 400, 60, 80)] } },
    { ticket: '29' },
    { codex: { earlier: { 'bill earlier codex': [earlier(9_000, 140, 260)], 'bill earlier codex again': [earlier(3_000, 25, 70)] } } },
  );
  const page = await launch(rig.env);
  await expect(page.locator('.xterm-rows')).not.toHaveText('', { timeout: FIRST_PAINT_MS });
  await setTokenCounts(page, true);
  await typeCommand(page, `cd ${shellQuote(rig.repo)}`);
  await expect(flowButton(page, 'Start')).toBeVisible();

  await typeCommand(page, 'codex');
  await flowButton(page, 'Start').click();
  await typeCommand(page, 'bill codex');
  await expectRail(page, { one: '21.9k counting', two: '—', three: '—' }, '21.9k');

  await flowButton(page, 'Advance').click();
  await quitAgent(page);
  await typeCommand(page, rig.earlierCodex!);
  await typeCommand(page, 'bill earlier codex');
  await expectRail(page, { one: '21.9k', two: '9.4k partly reported counting', three: '—' }, '31.3k partly reported');

  await flowButton(page, 'Advance').click();
  await quitAgent(page);
  await typeCommand(page, 'claude');
  await typeCommand(page, 'bill claude');
  await expectRail(page, { one: '21.9k', two: '9.4k partly reported', three: '5.5k counting' }, '36.9k partly reported');
  await quitAgent(page);
  await typeCommand(page, rig.earlierCodex!);
  await typeCommand(page, 'bill earlier codex again');
  await expectRail(page, { one: '21.9k', two: '9.4k partly reported', three: '8.6k partly reported counting' }, '40.0k partly reported');

  await flowStrip(page).locator('.loopstat').click();
  await expectTable(page, {
    one: ['20,000', '1,200', '300', '430'],
    two: ['9,000', 'not reported', '140', '260'],
    three: ['8,000 counting', '400 partly reported counting', '85 counting', '150 counting'],
    [RUN_TOTAL_ROW]: ['37,000', '1,600 partly reported', '525', '840'],
  });
});

// ---- Unavailable logs (#29) ----

const THREE_MANUAL_STEPS: AutoGateStep[] = [{ id: 'one', kind: 'manual' }, { id: 'two', kind: 'manual' }, { id: 'three', kind: 'manual' }];

/** Starts the flow, logs step one's spend through Claude Code and shows it counted. */
async function startWithClaudeSpend(page: Page, rig: TokenRig): Promise<void> {
  await setTokenCounts(page, true);
  await typeCommand(page, `cd ${shellQuote(rig.repo)}`);
  await expect(flowButton(page, 'Start')).toBeVisible();
  await typeCommand(page, 'claude');
  await flowButton(page, 'Start').click();
  await typeCommand(page, 'bill one');
  await expectRail(page, { one: '12.5k counting', two: '—', three: '—' }, '12.5k');
}

/** Every entered step and the run total read unavailable, step three keeps its dash, and the flow still advances. */
async function expectUnavailableThroughAdvance(page: Page): Promise<void> {
  await expectRail(page, { one: 'unavailable counting', two: '—', three: '—' }, 'unavailable');
  await flowButton(page, 'Advance').click();
  await expectRail(page, { one: 'unavailable', two: 'unavailable counting', three: '—' }, 'unavailable');
}

test('unavailable logs: no logs at all, then a dangling symlink in the Claude Code log folder, make every entered step and the run total unavailable, and the flow advances', { tag: '@ownapp' }, async () => {
  test.setTimeout(budget(1, 10));
  const rig = tokenRig('agent-term-e2e-tokens-unavailable-', THREE_MANUAL_STEPS, {}, { conversation: CONVERSATION });
  const page = await launch(rig.env);
  await expect(page.locator('.xterm-rows')).not.toHaveText('', { timeout: FIRST_PAINT_MS });
  await setTokenCounts(page, true);
  await typeCommand(page, `cd ${shellQuote(rig.repo)}`);
  await expect(flowButton(page, 'Start')).toBeVisible();

  await flowButton(page, 'Start').click();
  await expectRail(page, { one: 'unavailable counting', two: '—', three: '—' }, 'unavailable');

  await typeCommand(page, 'claude');
  await typeCommand(page, 'bill one');
  await expectRail(page, { one: '12.5k counting', two: '—', three: '—' }, '12.5k');

  const logDir = claudeCodeLogs(exampleConfigDir, rig.repo).dir;
  symlinkSync(join(logDir, 'gone.jsonl'), join(logDir, 'dangling.jsonl'));
  await expectUnavailableThroughAdvance(page);
});

test('unavailable logs: a Codex that runs in a manual step and logs nothing for the worktree makes the run unavailable, and the flow advances', { tag: '@ownapp' }, async () => {
  test.setTimeout(budget(1, 10));
  const elsewhere = tmp('agent-term-e2e-tokens-elsewhere-');
  const rig = tokenRig('agent-term-e2e-tokens-silent-codex-', THREE_MANUAL_STEPS, {}, { conversation: CONVERSATION }, {}, { codex: { cwd: elsewhere } });
  const page = await launch(rig.env);
  await expect(page.locator('.xterm-rows')).not.toHaveText('', { timeout: FIRST_PAINT_MS });
  await startWithClaudeSpend(page, rig);

  await quitAgent(page);
  await typeCommand(page, 'codex');
  await expectUnavailableThroughAdvance(page);
});

test('unavailable logs: a Codex whose log folder the app cannot find makes the run unavailable, and the flow advances', { tag: '@ownapp' }, async () => {
  test.setTimeout(budget(1, 10));
  const rig = tokenRig('agent-term-e2e-tokens-missing-codex-', THREE_MANUAL_STEPS, {}, { conversation: CONVERSATION }, {}, { codex: {} });
  const page = await launch({ ...rig.env, CODEX_HOME: join(tmp('agent-term-e2e-tokens-unseen-codex-'), 'absent') });
  await expect(page.locator('.xterm-rows')).not.toHaveText('', { timeout: FIRST_PAINT_MS });
  await startWithClaudeSpend(page, rig);

  await quitAgent(page);
  await typeCommand(page, 'codex');
  await expectUnavailableThroughAdvance(page);
});
