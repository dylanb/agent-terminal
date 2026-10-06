/// <reference lib="dom" />
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WINDOW_TIMEOUT_MS } from '../helpers/e2eBudget';
import { shellQuote } from '../../src/shared/shellQuote';
import { exampleConsolidatorOutput } from '../../src/shared/consolidatorOutput';
import { gateDecisionDecider, gateDecisionKind, parseAutoHaltReasons, parseAuditStream } from '../../src/shared/audit';
import { auditRepoDir, auditRootDir } from '../../src/main/auditPaths';
import { recordBaselineCommit } from '../../src/main/appLoopState';
import { exampleConfigDir, seedFakeAgentV2, seedFakeGhGit, type StepScript } from './fakeTools';
import {
  auditGateEntries,
  autoGateFlowYaml,
  loopRoster,
  seedAutoGateRepo,
  seedTrustedFlow,
  type AutoGateStep,
} from './autoGateHarness';

// #137 — §27.9.1 per-step gate authority: an `auto` loop step's clean gate is decided by the engine through the
// same approve a human click runs; anything else waits for the human.

const FIRST_PAINT_MS = 15_000;
const UI_MS = 10_000;
const LOOP_ROUND_MS = 60_000;
const APPROVE_ADVANCE_MS = 30_000;
const loopTestBudget = (uiWaits: number, approves: number): number =>
  WINDOW_TIMEOUT_MS + FIRST_PAINT_MS + LOOP_ROUND_MS + approves * APPROVE_ADVANCE_MS + uiWaits * UI_MS;

let app: ElectronApplication | undefined;
let page: Page;
const cleanup: string[] = [];

test.afterEach(async () => {
  await app?.close();
  app = undefined;
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const RED_RESULT_REL = '.agent-terminal/loop/artifacts/red-result.md';
const GREEN_RESULT_REL = '.agent-terminal/loop/artifacts/green-result.md';
const GROOMED_REL = '.agent-terminal/loop/artifacts/groomed-ticket.md';
const AUTO_RED_THEN_MANUAL: AutoGateStep[] = [
  { id: 'red', kind: 'loop', loop: 'red-loop', authority: 'auto' },
  { id: 'done', kind: 'manual' },
];

const tmp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
};
const readIf = (p: string): string => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const runState = (repo: string): string => readIf(join(repo, '.agent-terminal', 'loop', 'run-state.yaml'));
const flowState = (repo: string): string => readIf(join(repo, '.agent-terminal', 'flow-state.yaml'));
const gitIn = (repo: string, ...args: string[]): string => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
const gateDiagnosis = (home: string, repo: string): string => {
  let entries: string;
  try {
    entries = auditGateEntries(home, repo)
      .map((e) => `${e.cmd}${parseAutoHaltReasons(e.cmd) === null ? '' : ` → reasons ${JSON.stringify(parseAutoHaltReasons(e.cmd))}`}`)
      .join('\n');
  } catch (e) {
    entries = `unreadable: ${e instanceof Error ? e.message : String(e)}`;
  }
  return `run-state.yaml:\n${runState(repo)}\n§25 gate entries:\n${entries}`;
};

const loopReadout = () => page.locator('#flow-strip .loopstat');
const loopPanel = () => page.locator('#loop-panel');
const flowControl = () => page.locator('#flow-strip .flow-control');
const approveOption = () => loopPanel().locator('[data-gate-option="approve"]');

async function typeCommand(cmd: string): Promise<void> {
  await page.locator('.xterm-screen').click();
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe('TEXTAREA');
  await page.keyboard.type(cmd, { delay: 20 });
  await page.keyboard.press('Enter');
}

interface Launched {
  home: string;
  repo: string;
  logFile: string;
}

/** Launch the app on a fresh HOME with the fake tools first on PATH, `cd` into `repo` and host the fake agent. */
async function launchInto(prefix: string, repo: string, home: string, agent: StepScript & { stepId: string }, extraEnv: Record<string, string> = {}): Promise<Launched> {
  const { binDir, logFile } = seedFakeGhGit(`${prefix}bin-`, { realCommitOps: true });
  cleanup.push(binDir);
  seedFakeAgentV2(binDir, agent);
  app = await electron.launch({
    args: ['out/main/index.js', `--user-data-dir=${tmp(`${prefix}ud-`)}`],
    env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100', CLAUDE_CONFIG_DIR: exampleConfigDir, PATH: `${binDir}:${process.env.PATH}`, FAKE_GHGIT_LOG: logFile, ...extraEnv },
  });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(page.locator('.xterm-rows')).not.toHaveText('', { timeout: FIRST_PAINT_MS });
  await typeCommand(`cd ${shellQuote(repo)}`);
  await expect(flowControl()).toHaveText('Start', { timeout: UI_MS });
  await typeCommand('fake-agent');
  return { home, repo, logFile };
}

/** Count every insertion of the status-bar human-needed alert from now on. */
async function countAlertInsertions(): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __alertInsertions: number };
    w.__alertInsertions = 0;
    const bar = document.getElementById('status-bar');
    if (bar === null) throw new Error('no #status-bar');
    new MutationObserver((records) => {
      for (const r of records) {
        for (const n of Array.from(r.addedNodes)) {
          if (n instanceof Element && (n.matches('[data-status-alert]') || n.querySelector('[data-status-alert]') !== null)) w.__alertInsertions += 1;
        }
      }
    }).observe(bar, { childList: true, subtree: true });
  });
}
const alertInsertions = (): Promise<number> => page.evaluate(() => (window as unknown as { __alertInsertions: number }).__alertInsertions);

/** The gate commands of the repo's one §25 run file, read without a run identity (the test makes exactly one Start). */
function runGateCmds(home: string, repo: string): string[] {
  const dir = auditRepoDir(auditRootDir(home), repo);
  const files = readdirSync(dir);
  expect(files).toHaveLength(1);
  const { events } = parseAuditStream(readFileSync(join(dir, files[0]), 'utf8'));
  return events.flatMap((e) => (e.type === 'command' && e.source === 'gate' ? [e.cmd] : []));
}

async function openLoopPanel(): Promise<void> {
  if ((await loopReadout().getAttribute('aria-expanded')) !== 'true') await loopReadout().click();
}

const redAgent = (verdicts?: string[]): StepScript & { stepId: string } => ({
  stepId: 'red',
  artifactRel: RED_RESULT_REL,
  work: 'red',
  roster: loopRoster('red-loop'),
  ...(verdicts !== undefined ? { verdicts } : {}),
});

test('auto clean gate advances with its phase commit; no alert is raised and the audit marks the engine as the decider (AC1, AC8)', { tag: '@ownapp' }, async () => {
  test.setTimeout(loopTestBudget(3, 0));
  const home = tmp('agent-term-e2e-137-ac1-home-');
  const repo = seedAutoGateRepo('agent-term-e2e-137-ac1-', 'red');
  cleanup.push(repo);
  seedTrustedFlow(home, repo, 'auto-red', autoGateFlowYaml(AUTO_RED_THEN_MANUAL));
  const baseline = gitIn(repo, 'rev-parse', 'HEAD');
  await launchInto('agent-term-e2e-137-ac1-', repo, home, redAgent());
  await countAlertInsertions();

  await flowControl().click();

  // The engine approved the clean `red` gate: the flow moved on to the manual step with no gate click.
  await expect
    .poll(() => flowState(repo), { timeout: LOOP_ROUND_MS })
    .toMatch(/^step: done$/m)
    .catch((e: unknown) => {
      throw new Error(`${e instanceof Error ? e.message : String(e)}\n\n${gateDiagnosis(home, repo)}`);
    });
  expect(flowState(repo)).toMatch(/^status: in_progress$/m);
  await expect(flowControl()).toHaveText('Advance', { timeout: UI_MS });
  expect(gitIn(repo, 'log', '--format=%s', `${baseline}..HEAD`).split('\n')).toContain('RED');
  expect(await alertInsertions()).toBe(0);

  const entries = auditGateEntries(home, repo);
  const kinds = entries.map((e) => ({ kind: gateDecisionKind(e.cmd), decider: gateDecisionDecider(e.cmd) }));
  expect(kinds).toContainEqual({ kind: { family: 'gate', kind: 'decision', option: 'approve' }, decider: 'engine' });
  expect(kinds).toContainEqual({ kind: { family: 'gate', kind: 'side-effect', option: 'approve' }, decider: 'engine' });
  expect(entries.filter((e) => gateDecisionDecider(e.cmd) === 'human')).toEqual([]);
  expect(entries.filter((e) => parseAutoHaltReasons(e.cmd) !== null)).toEqual([]);
});

test('an auto gate whose verdict is stop for a human halts at the gate, names the reason, and the operator approve after it is human (AC2, AC8)', { tag: '@ownapp' }, async () => {
  test.setTimeout(loopTestBudget(4, 1));
  const home = tmp('agent-term-e2e-137-ac2-home-');
  const repo = seedAutoGateRepo('agent-term-e2e-137-ac2-', 'red');
  cleanup.push(repo);
  seedTrustedFlow(home, repo, 'auto-red', autoGateFlowYaml(AUTO_RED_THEN_MANUAL));
  const baseline = gitIn(repo, 'rev-parse', 'HEAD');
  await launchInto('agent-term-e2e-137-ac2-', repo, home, redAgent([exampleConsolidatorOutput('stop for a human', loopRoster('red-loop'))]));

  await flowControl().click();

  await expect.poll(() => runState(repo), { timeout: LOOP_ROUND_MS }).toContain('verdict: stop for a human');
  await openLoopPanel();
  await expect(approveOption()).toBeVisible({ timeout: UI_MS });
  expect(flowState(repo)).toMatch(/^step: red$/m);
  expect(gitIn(repo, 'rev-parse', 'HEAD')).toBe(baseline);
  // The halted gate needs the human: the strip pill carries the human-needed tone.
  await expect(page.locator('#flow-strip .spill')).toHaveClass(/\bawait\b/, { timeout: UI_MS });
  await expect(loopPanel().locator('[data-auto-halt-reason="stop-for-a-human"]')).toBeVisible();

  const halts = auditGateEntries(home, repo).filter((e) => gateDecisionKind(e.cmd)?.kind === 'auto-halt');
  expect(halts.map((e) => ({ reasons: parseAutoHaltReasons(e.cmd), decider: gateDecisionDecider(e.cmd) }))).toEqual([
    { reasons: ['stop-for-a-human'], decider: 'engine' },
  ]);

  await approveOption().click();
  await expect.poll(() => flowState(repo), { timeout: APPROVE_ADVANCE_MS }).toMatch(/^step: done$/m);
  const decisions = auditGateEntries(home, repo).filter((e) => gateDecisionKind(e.cmd)?.kind === 'decision');
  expect(decisions.map((e) => gateDecisionDecider(e.cmd))).toEqual(['human']);
  const engineEntries = auditGateEntries(home, repo).filter((e) => gateDecisionDecider(e.cmd) === 'engine');
  expect(engineEntries.map((e) => gateDecisionKind(e.cmd)?.kind)).toEqual(['auto-halt']);
});

// Plan S1 "No intermediate commit is unsafe": the completion is read from the shipped `green-loop` def through
// the app's own wiring, so a production resolution that drops `work.completion` advances here.
test('an auto step running a green-completion loop halts its clean gate with (e) until the frozen check lands: no engine approve, no commit (S1 stub)', { tag: '@ownapp' }, async () => {
  test.setTimeout(loopTestBudget(3, 0));
  const home = tmp('agent-term-e2e-137-e-home-');
  const repo = seedAutoGateRepo('agent-term-e2e-137-e-', 'green');
  cleanup.push(repo);
  recordBaselineCommit(repo, gitIn(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), gitIn(repo, 'rev-parse', 'HEAD'));
  seedTrustedFlow(home, repo, 'auto-green', autoGateFlowYaml([{ id: 'green', kind: 'loop', loop: 'green-loop', authority: 'auto' }, { id: 'done', kind: 'manual' }]));
  const baseline = gitIn(repo, 'rev-parse', 'HEAD');
  await launchInto('agent-term-e2e-137-e-', repo, home, { stepId: 'green', artifactRel: GREEN_RESULT_REL, work: 'green', touchTest: false, roster: loopRoster('green-loop') });

  await flowControl().click();

  await expect.poll(() => runState(repo), { timeout: LOOP_ROUND_MS }).toContain('verdict: clean');
  await openLoopPanel();
  await expect(loopPanel().locator('[data-auto-halt-reason="e"]')).toBeVisible({ timeout: UI_MS });
  expect(flowState(repo)).toMatch(/^step: green$/m);
  expect(gitIn(repo, 'rev-parse', 'HEAD')).toBe(baseline);
  const entries = auditGateEntries(home, repo);
  expect(entries.filter((e) => gateDecisionKind(e.cmd)?.kind === 'decision')).toEqual([]);
  expect(entries.flatMap((e) => parseAutoHaltReasons(e.cmd) ?? [])).toEqual(['e']);
});

test('pinning: a worktree-local copy of the same auto flow is untrusted: its clean gate waits for the human (AC1 trust leg)', { tag: '@ownapp' }, async () => {
  test.setTimeout(loopTestBudget(5, 0));
  const home = tmp('agent-term-e2e-137-local-home-');
  const repo = seedAutoGateRepo('agent-term-e2e-137-local-', 'red', { localFlowYaml: autoGateFlowYaml(AUTO_RED_THEN_MANUAL) });
  cleanup.push(repo);
  const baseline = gitIn(repo, 'rev-parse', 'HEAD');
  await launchInto('agent-term-e2e-137-local-', repo, home, redAgent());
  await countAlertInsertions();

  await flowControl().click();

  await expect.poll(() => runState(repo), { timeout: LOOP_ROUND_MS }).toContain('verdict: clean');
  await openLoopPanel();
  await expect(approveOption()).toBeVisible({ timeout: UI_MS });
  // The gate buttons also render while the engine decides, so wait for the settled human-needed signal first.
  await expect.poll(alertInsertions, { timeout: UI_MS }).toBeGreaterThanOrEqual(1);
  await expect(loopPanel().locator('[data-auto-deciding]')).toHaveCount(0);
  expect(flowState(repo)).toMatch(/^step: red$/m);
  expect(gitIn(repo, 'rev-parse', 'HEAD')).toBe(baseline);
  expect(runGateCmds(home, repo).filter((c) => gateDecisionKind(c)?.kind === 'decision' && gateDecisionDecider(c) === 'engine')).toEqual([]);
});

test('an invalid gate_authority fails the flow load: an unknown value, and the field on a manual step (AC6)', { tag: '@ownapp' }, async () => {
  test.setTimeout(WINDOW_TIMEOUT_MS + FIRST_PAINT_MS + 8 * UI_MS);
  const home = tmp('agent-term-e2e-137-ac6-home-');
  const unknownValue = seedAutoGateRepo('agent-term-e2e-137-ac6-unknown-', 'red');
  const onManual = seedAutoGateRepo('agent-term-e2e-137-ac6-manual-', 'red');
  cleanup.push(unknownValue, onManual);
  seedTrustedFlow(home, unknownValue, 'sometimes', autoGateFlowYaml(AUTO_RED_THEN_MANUAL).replace('gate_authority: auto', 'gate_authority: sometimes'));
  seedTrustedFlow(home, onManual, 'auto-manual', autoGateFlowYaml([
    { id: 'red', kind: 'loop', loop: 'red-loop' },
    { id: 'done', kind: 'manual', authority: 'auto' },
  ]));

  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-137-ac6-bin-');
  cleanup.push(binDir);
  app = await electron.launch({
    args: ['out/main/index.js', `--user-data-dir=${tmp('agent-term-e2e-137-ac6-ud-')}`],
    env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100', CLAUDE_CONFIG_DIR: exampleConfigDir, PATH: `${binDir}:${process.env.PATH}`, FAKE_GHGIT_LOG: logFile },
  });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(page.locator('.xterm-rows')).not.toHaveText('', { timeout: FIRST_PAINT_MS });

  // Each leg waits for an error naming its own step and value, so the second never reads the first's strip.
  const legs: [string, string, string | null][] = [
    [unknownValue, 'sometimes', null],
    [onManual, 'done', 'sometimes'],
  ];
  for (const [repo, named, absent] of legs) {
    await typeCommand(`cd ${shellQuote(repo)}`);
    const error = page.locator('#flow-strip .flow-error');
    await expect(error).toContainText(named, { timeout: UI_MS });
    if (absent !== null) await expect(error).not.toContainText(absent);
    await expect(error).toContainText('gate_authority');
    await expect(flowControl().filter({ hasText: 'Start' })).toHaveCount(0, { timeout: UI_MS });
  }
});

test('pinning: a human step on a trusted flow waits at its clean gate and the operator approve is recorded human (AC7)', { tag: '@ownapp' }, async () => {
  test.setTimeout(loopTestBudget(3, 1));
  const home = tmp('agent-term-e2e-137-ac7-home-');
  const repo = seedAutoGateRepo('agent-term-e2e-137-ac7-', 'groom', { ticket: '176' });
  cleanup.push(repo);
  seedTrustedFlow(home, repo, 'human-groom', autoGateFlowYaml([{ id: 'groom', kind: 'loop', loop: 'groom-loop', authority: 'human' }]));
  await launchInto('agent-term-e2e-137-ac7-', repo, home, { stepId: 'groom', artifactRel: GROOMED_REL, work: 'complete', roster: loopRoster('groom-loop') });
  await countAlertInsertions();

  await flowControl().click();

  await expect.poll(() => runState(repo), { timeout: LOOP_ROUND_MS }).toContain('verdict: clean');
  await openLoopPanel();
  await expect(approveOption()).toBeVisible({ timeout: UI_MS });
  expect(flowState(repo)).toMatch(/^step: groom$/m);
  await expect(page.locator('#flow-strip .spill')).toHaveClass(/\bsettle\b/, { timeout: UI_MS });
  // The positive pair of AC1's zero count: the same observer does see a human gate's alert.
  await expect.poll(alertInsertions, { timeout: UI_MS }).toBeGreaterThanOrEqual(1);
  for (const marker of ['[data-globs-review]', '[data-failed-effect]', '[data-auto-deciding]', '[data-auto-halt-reason]']) {
    await expect(loopPanel().locator(marker)).toHaveCount(0);
  }

  await approveOption().click();
  await expect.poll(() => flowState(repo), { timeout: APPROVE_ADVANCE_MS }).toMatch(/^status: done$/m);

  const gateCmds = runGateCmds(home, repo);
  expect(gateCmds).toContain('§27 gate approve');
  expect(gateCmds.filter((c) => gateDecisionKind(c)?.kind === 'decision').map((c) => gateDecisionDecider(c))).toEqual(['human']);
  expect(gateCmds.filter((c) => gateDecisionDecider(c) === 'engine')).toEqual([]);
});

test('a manual Advance while a human approve runs its side-effect moves the flow once: the approve does not advance it again (N9b.5(e))', { tag: '@ownapp' }, async () => {
  test.setTimeout(loopTestBudget(4, 1));
  const home = tmp('agent-term-e2e-137-scoped-home-');
  const repo = seedAutoGateRepo('agent-term-e2e-137-scoped-', 'groom', { ticket: '176' });
  cleanup.push(repo);
  seedTrustedFlow(home, repo, 'scoped', autoGateFlowYaml([
    { id: 'groom', kind: 'loop', loop: 'groom-loop', authority: 'human' },
    { id: 'next', kind: 'manual' },
    { id: 'after', kind: 'manual' },
  ]));
  const hold = join(tmp('agent-term-e2e-137-scoped-hold-'), 'hold');
  writeFileSync(hold, '');
  const { logFile } = await launchInto('agent-term-e2e-137-scoped-', repo, home, { stepId: 'groom', artifactRel: GROOMED_REL, work: 'complete', roster: loopRoster('groom-loop') }, {
    FAKE_GH_HOLD: hold,
    FAKE_GH_HOLD_ACTION: 'update-issue-body',
  });

  await flowControl().click();

  await expect.poll(() => runState(repo), { timeout: LOOP_ROUND_MS }).toContain('verdict: clean');
  await openLoopPanel();
  await approveOption().click();
  await expect.poll(() => readIf(logFile), { timeout: UI_MS }).toMatch(/^held \d+ gh issue edit/m);

  await expect(flowControl()).toHaveText('Advance', { timeout: UI_MS });
  await flowControl().click();
  await expect.poll(() => flowState(repo), { timeout: UI_MS }).toMatch(/^step: next$/m);

  rmSync(hold);
  await expect.poll(() => runGateCmds(home, repo), { timeout: APPROVE_ADVANCE_MS }).toContain('§27 gate approve');
  // The approve writes its `decision` entry then advances in one main-process turn; this round-trip is answered only after that turn.
  await page.evaluate((k) => window.flow.state(k), repo);
  expect(flowState(repo)).toMatch(/^step: next$/m);
});
