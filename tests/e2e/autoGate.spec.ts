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
import { readChangedTests, recordBaselineCommit, recordChangedTests } from '../../src/main/appLoopState';
import { readGateRunState } from '../../src/main/gateRunState';
import { completionMarker } from '../../src/main/appWorkTurn';
import { exampleEpicPlan } from '../../src/shared/epicPlan';
import { b64, exampleConfigDir, seedFakeAgentSteps, seedFakeAgentV2, seedFakeGhGit, seedFullTddChainAgent, type StepScript } from './fakeTools';
import {
  auditGateEntries,
  autoGateFlowYaml,
  loopRoster,
  runIdentity,
  seedAutoGateRepo,
  seedTrustedFlow,
  type AutoGateStep,
  type GateEntry,
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

const RED_RESULT_REL = '.agent-terminal/loop/artifacts/red-result.json';
const GREEN_RESULT_REL = '.agent-terminal/loop/artifacts/green-result.json';
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

const failWithDiagnosis =
  (home: string, repo: string) =>
  (e: unknown): never => {
    throw new Error(`${e instanceof Error ? e.message : String(e)}\n\n${gateDiagnosis(home, repo)}`);
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

/** Launch the app on `home` with the fake tools first on PATH, `cd` into `repo` and host the fake agent. `control`
 *  is the strip control the repo's flow shows on arrival: `Start` for a fresh run, `Restart` for a `done` one, null for a relaunched one. */
async function launchInto(
  prefix: string,
  repo: string,
  home: string,
  agent: (StepScript & { stepId: string }) | Record<string, StepScript> | ((binDir: string) => void),
  extraEnv: Record<string, string> = {},
  control: 'Start' | 'Restart' | null = 'Start',
): Promise<Launched> {
  const { binDir, logFile } = seedFakeGhGit(`${prefix}bin-`, { realCommitOps: true });
  cleanup.push(binDir);
  if (typeof agent === 'function') agent(binDir);
  else if ('stepId' in agent && typeof agent.stepId === 'string') seedFakeAgentV2(binDir, agent as StepScript & { stepId: string });
  else seedFakeAgentSteps(binDir, agent as Record<string, StepScript>);
  app = await electron.launch({
    args: ['out/main/index.js', `--user-data-dir=${tmp(`${prefix}ud-`)}`],
    env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100', CLAUDE_CONFIG_DIR: exampleConfigDir, PATH: `${binDir}:${process.env.PATH}`, FAKE_GHGIT_LOG: logFile, ...extraEnv },
  });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(page.locator('.xterm-rows')).not.toHaveText('', { timeout: FIRST_PAINT_MS });
  await typeCommand(`cd ${shellQuote(repo)}`);
  if (control !== null) await expect(flowControl()).toHaveText(control, { timeout: UI_MS });
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

/** Record every `CH.flowOnLoopError` error reason the renderer receives from now on (the dialog host shows only the latest). */
async function recordLoopErrors(): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __loopErrors: string[] };
    w.__loopErrors = [];
    window.flow.onLoopError((reason, kind) => {
      if (kind === 'error') w.__loopErrors.push(reason);
    });
  });
}
const loopErrors = (): Promise<string[]> => page.evaluate(() => (window as unknown as { __loopErrors: string[] }).__loopErrors);

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
    .catch(failWithDiagnosis(home, repo));
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

// #137 S4 — §27.9.1 N9b.7: the engine's own frozen check at the approve of an `auto` GREEN step, against the
// phase baseline. The completion is read from the shipped `green-loop` def through the app's own wiring.
const AUTO_GREEN_THEN_MANUAL: AutoGateStep[] = [
  { id: 'green', kind: 'loop', loop: 'green-loop', authority: 'auto' },
  { id: 'done', kind: 'manual' },
];
const greenAgent = (over: Partial<StepScript> = {}): StepScript => ({
  artifactRel: GREEN_RESULT_REL,
  work: 'green',
  touchTest: false,
  roster: loopRoster('green-loop'),
  ...over,
});
const haltRows = () => loopPanel().locator('[data-auto-halt-reason]');
const autoHaltsAt = (home: string, repo: string, step: string): GateEntry[] =>
  auditGateEntries(home, repo, { step }).filter((e) => gateDecisionKind(e.cmd)?.kind === 'auto-halt');

async function startAutoGreen(prefix: string, agent: StepScript, steps: AutoGateStep[] = AUTO_GREEN_THEN_MANUAL): Promise<{ home: string; repo: string; baseline: string }> {
  const home = tmp(`${prefix}home-`);
  const repo = seedAutoGateRepo(prefix, 'green');
  cleanup.push(repo);
  const baseline = gitIn(repo, 'rev-parse', 'HEAD');
  recordBaselineCommit(repo, gitIn(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), baseline);
  seedTrustedFlow(home, repo, 'auto-green', autoGateFlowYaml(steps));
  await launchInto(prefix, repo, home, { green: agent });
  await flowControl().click();
  return { home, repo, baseline };
}

test('auto GREEN halts on frozen-test change and on unavailable check: a control round that edits no test is engine-approved (AC12)', { tag: '@ownapp' }, async () => {
  test.setTimeout(loopTestBudget(2, 1));
  const { home, repo } = await startAutoGreen('agent-term-e2e-137-frozen-ok-', greenAgent());

  await expect
    .poll(() => flowState(repo), { timeout: LOOP_ROUND_MS + APPROVE_ADVANCE_MS })
    .toMatch(/^step: done$/m)
    .catch(failWithDiagnosis(home, repo));
  const entries = auditGateEntries(home, repo, { step: 'green' });
  expect(entries.filter((e) => gateDecisionKind(e.cmd)?.kind === 'decision').map((e) => gateDecisionDecider(e.cmd))).toEqual(['engine']);
  expect(entries.filter((e) => gateDecisionKind(e.cmd)?.kind === 'auto-halt')).toEqual([]);
});

test('auto GREEN halts on frozen-test change and on unavailable check: a round that edited a test halts with (d) and the flag lists the file (AC12)', { tag: '@ownapp' }, async () => {
  test.setTimeout(loopTestBudget(3, 0));
  const { home, repo, baseline } = await startAutoGreen('agent-term-e2e-137-frozen-d-', greenAgent({ touchTest: true }));

  await expect.poll(() => runState(repo), { timeout: LOOP_ROUND_MS }).toContain('verdict: clean');
  await openLoopPanel();
  await expect(haltRows().first()).toBeVisible({ timeout: UI_MS });
  expect(autoHaltsAt(home, repo, 'green').map((e) => parseAutoHaltReasons(e.cmd))).toEqual([['frozen-tests-changed']]);
  await expect(loopPanel().locator('[data-auto-halt-reason="frozen-tests-changed"]')).toBeVisible();
  expect(readChangedTests(repo)?.paths).toContain('tests/frozen.test.ts');
  expect(flowState(repo)).toMatch(/^step: green$/m);
  expect(gitIn(repo, 'rev-parse', 'HEAD')).toBe(baseline);
});

// §27.9.1 N9b.10
const injectedLog = (repo: string): string => readIf(join(repo, '.agent-terminal', 'injected-log'));

test('a gate that stops for the operator asks the agent why: an `auto` (d) halt names the reason and the changed test, in the agent and the panel', { tag: '@ownapp' }, async () => {
  test.setTimeout(loopTestBudget(3, 0));
  const { home, repo } = await startAutoGreen('agent-term-e2e-why-d-', greenAgent({ touchTest: true, logInjected: true }));

  await expect.poll(() => runState(repo), { timeout: LOOP_ROUND_MS }).toContain('verdict: clean');
  await expect
    .poll(() => injectedLog(repo), { timeout: UI_MS })
    .toContain('Why does this gate need me?')
    .catch(failWithDiagnosis(home, repo));
  const log = injectedLog(repo);
  expect(log).toContain('(d) frozen tests changed: tests/frozen.test.ts');
  expect(log.split('Why does this gate need me?')).toHaveLength(2);
  await openLoopPanel();
  await expect(loopPanel().locator('[data-auto-halt-reason="frozen-tests-changed"]')).toContainText('tests/frozen.test.ts', { timeout: UI_MS });
  expect(flowState(repo)).toMatch(/^step: green$/m);
});

test('a gate that stops for the operator asks the agent why: a `human` gate says it is the operator\'s by design', { tag: '@ownapp' }, async () => {
  test.setTimeout(loopTestBudget(2, 0));
  const steps: AutoGateStep[] = [
    { id: 'green', kind: 'loop', loop: 'green-loop', authority: 'human' },
    { id: 'done', kind: 'manual' },
  ];
  const { home, repo } = await startAutoGreen('agent-term-e2e-why-human-', greenAgent({ logInjected: true }), steps);

  await expect.poll(() => runState(repo), { timeout: LOOP_ROUND_MS }).toContain('verdict: clean');
  await expect
    .poll(() => injectedLog(repo), { timeout: UI_MS })
    .toContain('Why does this gate need me?')
    .catch(failWithDiagnosis(home, repo));
  expect(injectedLog(repo)).toMatch(/the operator's by design/);
  expect(flowState(repo)).toMatch(/^step: green$/m);
});

test('auto GREEN halts on frozen-test change and on unavailable check: `loop-capabilities.yaml` removed before the approve halts with (e) naming it, not (b) (AC12)', { tag: '@ownapp' }, async () => {
  test.setTimeout(loopTestBudget(3, 0));
  const { home, repo, baseline } = await startAutoGreen('agent-term-e2e-137-frozen-e-', greenAgent({ extraShell: { consolidate: ['rm -f loop-capabilities.yaml'] } }));

  await expect.poll(() => runState(repo), { timeout: LOOP_ROUND_MS }).toContain('verdict: clean');
  await openLoopPanel();
  await expect(haltRows().first()).toBeVisible({ timeout: UI_MS });
  const halts = autoHaltsAt(home, repo, 'green');
  expect(halts.map((e) => parseAutoHaltReasons(e.cmd))).toEqual([['frozen-check-unavailable']]);
  expect(halts[0].cmd).toContain('loop-capabilities.yaml');
  await expect(loopPanel().locator('[data-auto-halt-reason="frozen-check-unavailable"]')).toContainText('loop-capabilities.yaml');
  await expect(loopPanel().locator('[data-auto-halt-reason="loop-error"]')).toHaveCount(0);
  expect(gitIn(repo, 'rev-parse', 'HEAD')).toBe(baseline);
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

// ── #137 S2: the visible halt reasons (a), (b), (i), and the run-end report ──

const errorDialog = () => page.locator('#flow-error-host .flow-modal');

/** Dismiss every blocking loop-error dialog currently shown, so the panel behind it can be opened. */
async function dismissLoopErrors(): Promise<void> {
  while ((await errorDialog().count()) > 0 && (await errorDialog().first().isVisible())) {
    await errorDialog().first().locator('.dismiss').click();
  }
}

const autoHaltReasons = (home: string, repo: string): (string[] | null)[] =>
  auditGateEntries(home, repo).filter((e) => gateDecisionKind(e.cmd)?.kind === 'auto-halt').map((e) => parseAutoHaltReasons(e.cmd));
const engineDecisions = (home: string, repo: string): string[] =>
  auditGateEntries(home, repo).filter((e) => gateDecisionKind(e.cmd)?.kind === 'decision' && gateDecisionDecider(e.cmd) === 'engine').map((e) => e.cmd);

const NO_VERDICT = 'this consolidator output carries no verdict at all\n';
const STALL_ENV = { APP_TURN_TIMEOUT_MS: '60000' };

test('auto gate halts with each visible reason: (a) a round recording `needs a human` holds the clean gate, with one alert (AC3)', { tag: '@ownapp' }, async () => {
  test.setTimeout(loopTestBudget(5, 0));
  const home = tmp('agent-term-e2e-137-a-home-');
  const repo = seedAutoGateRepo('agent-term-e2e-137-a-', 'red');
  cleanup.push(repo);
  seedTrustedFlow(home, repo, 'auto-red', autoGateFlowYaml(AUTO_RED_THEN_MANUAL));
  const baseline = gitIn(repo, 'rev-parse', 'HEAD');
  await launchInto('agent-term-e2e-137-a-', repo, home, { ...redAgent(), reviews: ['needs-human'] });
  await countAlertInsertions();

  await flowControl().click();

  await expect.poll(() => runState(repo), { timeout: LOOP_ROUND_MS }).toContain('verdict: clean');
  await openLoopPanel();
  await expect(loopPanel().locator('[data-auto-halt-reason="needs-a-human"]')).toBeVisible({ timeout: UI_MS });
  expect(flowState(repo)).toMatch(/^step: red$/m);
  expect(gitIn(repo, 'rev-parse', 'HEAD')).toBe(baseline);
  await expect.poll(alertInsertions, { timeout: UI_MS }).toBe(1);
  expect(engineDecisions(home, repo)).toEqual([]);
  expect(autoHaltReasons(home, repo).map((r) => r?.includes('needs-a-human'))).toEqual([true]);
  await page.evaluate((k) => window.flow.state(k), repo);
  expect(await alertInsertions()).toBe(1);
});

test('auto gate halts with each visible reason: (b) the error stop of an `auto` step shows (b) and does not advance (AC4 i)', { tag: '@ownapp' }, async () => {
  test.setTimeout(loopTestBudget(5, 0));
  const home = tmp('agent-term-e2e-137-b-home-');
  const repo = seedAutoGateRepo('agent-term-e2e-137-b-', 'red');
  cleanup.push(repo);
  seedTrustedFlow(home, repo, 'auto-red', autoGateFlowYaml(AUTO_RED_THEN_MANUAL));
  const baseline = gitIn(repo, 'rev-parse', 'HEAD');
  await launchInto('agent-term-e2e-137-b-', repo, home, redAgent([NO_VERDICT]), STALL_ENV);

  await flowControl().click();

  await expect.poll(() => runState(repo), { timeout: LOOP_ROUND_MS }).toMatch(/^status: error$/m);
  await expect(errorDialog()).toBeVisible({ timeout: UI_MS });
  await dismissLoopErrors();
  await openLoopPanel();
  await expect(loopPanel().locator('[data-auto-halt-reason="loop-error"]')).toBeVisible({ timeout: UI_MS });
  expect(flowState(repo)).toMatch(/^step: red$/m);
  expect(gitIn(repo, 'rev-parse', 'HEAD')).toBe(baseline);
  expect(engineDecisions(home, repo)).toEqual([]);
  expect(autoHaltReasons(home, repo).map((r) => r?.includes('loop-error'))).toEqual([true]);
});

test('(b): a review round the operator Accepts out of its error at an `auto` step holds the step: (b) shown, no advance (AC4 ii)', { tag: '@ownapp' }, async () => {
  test.setTimeout(loopTestBudget(6, 0));
  const home = tmp('agent-term-e2e-137-b2-home-');
  const repo = seedAutoGateRepo('agent-term-e2e-137-b2-', 'red');
  cleanup.push(repo);
  seedTrustedFlow(home, repo, 'auto-red', autoGateFlowYaml(AUTO_RED_THEN_MANUAL));
  const baseline = gitIn(repo, 'rev-parse', 'HEAD');
  await launchInto('agent-term-e2e-137-b2-', repo, home, { ...redAgent(), review: 'omit-persona' }, STALL_ENV);

  await flowControl().click();

  await expect.poll(() => runState(repo), { timeout: LOOP_ROUND_MS }).toMatch(/^status: error$/m);
  await expect(errorDialog()).toBeVisible({ timeout: UI_MS });
  await dismissLoopErrors();
  await openLoopPanel();
  await loopPanel().locator('[data-app-route-out="accept"]').click({ timeout: UI_MS });
  await expect(loopPanel().locator('[data-auto-halt-reason="loop-error"]')).toBeVisible({ timeout: LOOP_ROUND_MS });
  expect(flowState(repo)).toMatch(/^step: red$/m);
  expect(gitIn(repo, 'rev-parse', 'HEAD')).toBe(baseline);
  expect(engineDecisions(home, repo)).toEqual([]);
  expect(autoHaltReasons(home, repo).filter((r) => r?.includes('loop-error'))).toHaveLength(1);
});

test('(b) negative: a Retry out of the error stop whose round then comes back clean advances the `auto` step (AC4 iii, N9b.6(b))', { tag: '@ownapp' }, async () => {
  test.setTimeout(loopTestBudget(6, 0));
  const home = tmp('agent-term-e2e-137-b3-home-');
  const repo = seedAutoGateRepo('agent-term-e2e-137-b3-', 'red');
  cleanup.push(repo);
  seedTrustedFlow(home, repo, 'auto-red', autoGateFlowYaml(AUTO_RED_THEN_MANUAL));
  await launchInto(
    'agent-term-e2e-137-b3-',
    repo,
    home,
    { ...redAgent(), consolidateAttempts: [NO_VERDICT, NO_VERDICT, exampleConsolidatorOutput('clean', loopRoster('red-loop'))] },
    STALL_ENV,
  );

  await flowControl().click();

  await expect.poll(() => runState(repo), { timeout: LOOP_ROUND_MS }).toMatch(/^status: error$/m);
  await expect(errorDialog()).toBeVisible({ timeout: UI_MS });
  await dismissLoopErrors();
  await openLoopPanel();
  await loopPanel().locator('[data-app-route-out="retry"]').click({ timeout: UI_MS });
  await expect.poll(() => flowState(repo), { timeout: LOOP_ROUND_MS }).toMatch(/^step: done$/m);
  expect(engineDecisions(home, repo)).toHaveLength(1);
});

test('(b) negative: at the `human` step of a run that also binds an `auto` step, an error stop shows no halt reason and writes no engine entry (AC4 iv)', { tag: '@ownapp' }, async () => {
  test.setTimeout(loopTestBudget(5, 0));
  const home = tmp('agent-term-e2e-137-b4-home-');
  const repo = seedAutoGateRepo('agent-term-e2e-137-b4-', 'red');
  cleanup.push(repo);
  seedTrustedFlow(home, repo, 'human-then-auto', autoGateFlowYaml([
    { id: 'red', kind: 'loop', loop: 'red-loop', authority: 'human' },
    { id: 'red2', kind: 'loop', loop: 'red-loop', authority: 'auto' },
    { id: 'done', kind: 'manual' },
  ]));
  await launchInto('agent-term-e2e-137-b4-', repo, home, redAgent([NO_VERDICT]), STALL_ENV);

  await flowControl().click();

  await expect.poll(() => runState(repo), { timeout: LOOP_ROUND_MS }).toMatch(/^status: error$/m);
  await expect(errorDialog()).toBeVisible({ timeout: UI_MS });
  await dismissLoopErrors();
  await openLoopPanel();
  await expect(loopPanel().locator('[data-app-route-out="retry"]')).toBeVisible({ timeout: UI_MS });
  await expect(loopPanel().locator('[data-auto-halt-reason]')).toHaveCount(0);
  expect(auditGateEntries(home, repo).filter((e) => gateDecisionDecider(e.cmd) === 'engine')).toEqual([]);
});

test('(b) negative: at the `human` step of a run that also binds an `auto` step, an Accepted failed review round shows no halt reason and writes no engine entry (AC4 iv)', { tag: '@ownapp' }, async () => {
  test.setTimeout(loopTestBudget(6, 0));
  const home = tmp('agent-term-e2e-137-b4a-home-');
  const repo = seedAutoGateRepo('agent-term-e2e-137-b4a-', 'red');
  cleanup.push(repo);
  seedTrustedFlow(home, repo, 'human-then-auto', autoGateFlowYaml([
    { id: 'red', kind: 'loop', loop: 'red-loop', authority: 'human' },
    { id: 'red2', kind: 'loop', loop: 'red-loop', authority: 'auto' },
    { id: 'done', kind: 'manual' },
  ]));
  await launchInto('agent-term-e2e-137-b4a-', repo, home, { ...redAgent(), review: 'omit-persona' }, STALL_ENV);

  await flowControl().click();

  await expect.poll(() => runState(repo), { timeout: LOOP_ROUND_MS }).toMatch(/^status: error$/m);
  await expect(errorDialog()).toBeVisible({ timeout: UI_MS });
  await dismissLoopErrors();
  await openLoopPanel();
  await loopPanel().locator('[data-app-route-out="accept"]').click({ timeout: UI_MS });
  await expect.poll(() => runState(repo), { timeout: LOOP_ROUND_MS }).toMatch(/^status: complete$/m);
  await expect(flowControl()).toHaveText('Advance', { timeout: UI_MS });
  await expect(loopPanel().locator('[data-auto-halt-reason]')).toHaveCount(0);
  expect(flowState(repo)).toMatch(/^step: red$/m);
  expect(auditGateEntries(home, repo).filter((e) => gateDecisionDecider(e.cmd) === 'engine')).toEqual([]);
});

const GROOM_AGENT: StepScript = { artifactRel: GROOMED_REL, work: 'complete', roster: loopRoster('groom-loop') };

test('auto gate halts with each visible reason: (i) a failed `gh` effect of an engine approve is marked at the next gate, which halts (AC13)', { tag: '@ownapp' }, async () => {
  test.setTimeout(loopTestBudget(6, 0));
  const home = tmp('agent-term-e2e-137-i-home-');
  const repo = seedAutoGateRepo('agent-term-e2e-137-i-', 'groom', { ticket: '176' });
  cleanup.push(repo);
  seedTrustedFlow(home, repo, 'auto-groom-red', autoGateFlowYaml([
    { id: 'groom', kind: 'loop', loop: 'groom-loop', authority: 'auto' },
    { id: 'red', kind: 'loop', loop: 'red-loop', authority: 'auto' },
    { id: 'done', kind: 'manual' },
  ]));
  const { stepId: _red, ...red } = redAgent();
  const { logFile } = await launchInto('agent-term-e2e-137-i-', repo, home, { groom: GROOM_AGENT, red }, { FAKE_GH_FAIL_ACTION: 'update-issue-body' });

  await flowControl().click();

  await expect.poll(() => flowState(repo), { timeout: LOOP_ROUND_MS }).toMatch(/^step: red$/m);
  expect(readIf(logFile)).toMatch(/gh issue edit/);
  await expect.poll(() => runState(repo), { timeout: LOOP_ROUND_MS }).toMatch(/^step: red$[\s\S]*verdict: clean/m);
  await dismissLoopErrors();
  await openLoopPanel();
  await expect(loopPanel().locator('[data-failed-effect="set"]')).toBeVisible({ timeout: UI_MS });
  await expect(loopPanel().locator('[data-auto-halt-reason="failed-effect"]')).toBeVisible();
  expect(flowState(repo)).toMatch(/^step: red$/m);
  expect(auditGateEntries(home, repo, { step: 'red' }).filter((e) => gateDecisionKind(e.cmd)?.kind === 'decision')).toEqual([]);
  expect(autoHaltReasons(home, repo).filter((r) => r?.includes('failed-effect'))).toHaveLength(1);
});

test('a human approve at a gate showing the failed-effect marker clears it: the next `auto` gate is engine-approved with no (i) (AC13, N9b.5(d))', { tag: '@ownapp' }, async () => {
  test.setTimeout(loopTestBudget(8, 2) + 2 * LOOP_ROUND_MS);
  const home = tmp('agent-term-e2e-137-clear-home-');
  const repo = seedAutoGateRepo('agent-term-e2e-137-clear-', 'groom', { ticket: '176' });
  cleanup.push(repo);
  seedTrustedFlow(home, repo, 'auto-groom-human-red-auto-red', autoGateFlowYaml([
    { id: 'groom', kind: 'loop', loop: 'groom-loop', authority: 'auto' },
    { id: 'red', kind: 'loop', loop: 'red-loop', authority: 'human' },
    { id: 'red2', kind: 'loop', loop: 'red-loop', authority: 'auto' },
    { id: 'done', kind: 'manual' },
  ]));
  const { stepId: _red, ...red } = redAgent();
  await launchInto('agent-term-e2e-137-clear-', repo, home, {
    groom: GROOM_AGENT,
    red,
    // red2 authors a test file of its own: red's phase commit already carries `tests/red_added.test.ts`.
    red2: { ...red, writeTest: false, extraShell: { work: [`mkdir -p tests; printf '%s\\n' 'test("red2", () => { expect(1).toBe(2); });' > tests/red2_added.test.ts`] } },
  }, { FAKE_GH_FAIL_ACTION: 'update-issue-body' });

  await flowControl().click();

  await expect.poll(() => flowState(repo), { timeout: LOOP_ROUND_MS }).toMatch(/^step: red$/m);
  await expect.poll(() => runState(repo), { timeout: LOOP_ROUND_MS }).toMatch(/^step: red$[\s\S]*verdict: clean/m);
  await dismissLoopErrors();
  await openLoopPanel();
  await expect(loopPanel().locator('[data-failed-effect="set"]')).toBeVisible({ timeout: UI_MS });
  await approveOption().click({ timeout: UI_MS });
  await expect.poll(() => flowState(repo), { timeout: APPROVE_ADVANCE_MS }).toMatch(/^step: red2$/m);
  await expect
    .poll(() => flowState(repo), { timeout: LOOP_ROUND_MS + APPROVE_ADVANCE_MS })
    .toMatch(/^step: done$/m)
    .catch(failWithDiagnosis(home, repo));
  expect(autoHaltReasons(home, repo).filter((r) => r?.includes('failed-effect'))).toEqual([]);
  expect(auditGateEntries(home, repo, { step: 'red2' }).filter((e) => gateDecisionKind(e.cmd)?.kind === 'decision' && gateDecisionDecider(e.cmd) === 'engine')).toHaveLength(1);
});

test('the strip\'s manual Advance at a gate showing the failed-effect marker clears it: the next `auto` gate is engine-approved with no (i) (AC13, N9b.5(d))', { tag: '@ownapp' }, async () => {
  test.setTimeout(loopTestBudget(8, 2) + 2 * LOOP_ROUND_MS);
  const home = tmp('agent-term-e2e-137-advclear-home-');
  const repo = seedAutoGateRepo('agent-term-e2e-137-advclear-', 'groom', { ticket: '176' });
  cleanup.push(repo);
  seedTrustedFlow(home, repo, 'auto-groom-human-red-auto-red', autoGateFlowYaml([
    { id: 'groom', kind: 'loop', loop: 'groom-loop', authority: 'auto' },
    { id: 'red', kind: 'loop', loop: 'red-loop', authority: 'human' },
    { id: 'red2', kind: 'loop', loop: 'red-loop', authority: 'auto' },
    { id: 'done', kind: 'manual' },
  ]));
  const { stepId: _red, ...red } = redAgent();
  await launchInto('agent-term-e2e-137-advclear-', repo, home, {
    groom: GROOM_AGENT,
    red,
    red2: { ...red, writeTest: false, extraShell: { work: [`mkdir -p tests; printf '%s\\n' 'test("red2", () => { expect(1).toBe(2); });' > tests/red2_added.test.ts`] } },
  }, { FAKE_GH_FAIL_ACTION: 'update-issue-body' });

  await flowControl().click();

  await expect.poll(() => flowState(repo), { timeout: LOOP_ROUND_MS }).toMatch(/^step: red$/m);
  await expect.poll(() => runState(repo), { timeout: LOOP_ROUND_MS }).toMatch(/^step: red$[\s\S]*verdict: clean/m);
  await dismissLoopErrors();
  await openLoopPanel();
  await expect(loopPanel().locator('[data-failed-effect="set"]')).toBeVisible({ timeout: UI_MS });
  await expect(flowControl()).toHaveText('Advance', { timeout: UI_MS });
  await flowControl().click();
  await expect.poll(() => flowState(repo), { timeout: APPROVE_ADVANCE_MS }).toMatch(/^step: red2$/m);
  await expect
    .poll(() => flowState(repo), { timeout: LOOP_ROUND_MS + APPROVE_ADVANCE_MS })
    .toMatch(/^step: done$/m)
    .catch(failWithDiagnosis(home, repo));
  expect(autoHaltReasons(home, repo).filter((r) => r?.includes('failed-effect'))).toEqual([]);
  expect(auditGateEntries(home, repo, { step: 'red2' }).filter((e) => gateDecisionKind(e.cmd)?.kind === 'decision' && gateDecisionDecider(e.cmd) === 'engine')).toHaveLength(1);
});

test('flow:advance through the preload carries the step the strip showed: an Advance naming a step the flow has left moves nothing, the shown step advances, and one naming no step advances the current step (N9b.5(d), §6 v2.185)', { tag: '@ownapp' }, async () => {
  test.setTimeout(loopTestBudget(3, 1));
  const home = tmp('agent-term-e2e-137-staleadv-home-');
  const repo = seedAutoGateRepo('agent-term-e2e-137-staleadv-', 'groom', { ticket: '176' });
  cleanup.push(repo);
  seedTrustedFlow(home, repo, 'human-groom-finalize', autoGateFlowYaml([
    { id: 'groom', kind: 'loop', loop: 'groom-loop', authority: 'human' },
    { id: 'finalize', kind: 'manual' },
  ]));
  await launchInto('agent-term-e2e-137-staleadv-', repo, home, { stepId: 'groom', artifactRel: GROOMED_REL, work: 'complete', roster: loopRoster('groom-loop') });
  const advance = (step: string): Promise<unknown> =>
    page.evaluate(
      ([key, s]) => (window.flow.advance as (repoKey: string, step?: string) => Promise<unknown>)(key, s),
      [repo, step] as const,
    );

  await flowControl().click();

  await expect.poll(() => runState(repo), { timeout: LOOP_ROUND_MS }).toContain('verdict: clean');
  await expect(flowControl()).toHaveText('Advance', { timeout: UI_MS });
  await advance('finalize');
  expect(flowState(repo)).toMatch(/^step: groom$/m);
  await advance('groom');
  await expect.poll(() => flowState(repo), { timeout: APPROVE_ADVANCE_MS }).toMatch(/^step: finalize$/m);
  // §6 v2.185 — a request naming no step advances the current one.
  await page.evaluate((key) => window.flow.advance(key), repo);
  await expect.poll(() => flowState(repo), { timeout: UI_MS }).toMatch(/^status: done$/m);
});

test('a failed effect on the last auto step is shown at run end: the failure reaches the operator and one (i) entry is recorded (AC13)', { tag: '@ownapp' }, async () => {
  test.setTimeout(loopTestBudget(6, 0));
  const home = tmp('agent-term-e2e-137-end-home-');
  const repo = seedAutoGateRepo('agent-term-e2e-137-end-', 'groom', { ticket: '176' });
  cleanup.push(repo);
  seedTrustedFlow(home, repo, 'auto-groom-end', autoGateFlowYaml([
    { id: 'groom', kind: 'loop', loop: 'groom-loop', authority: 'auto' },
    { id: 'finalize', kind: 'manual' },
  ]));
  await launchInto('agent-term-e2e-137-end-', repo, home, { stepId: 'groom', ...GROOM_AGENT }, { FAKE_GH_FAIL_ACTION: 'update-issue-body' });
  await recordLoopErrors();

  await flowControl().click();

  await expect.poll(() => flowState(repo), { timeout: LOOP_ROUND_MS }).toMatch(/^step: finalize$/m);
  await expect(errorDialog().first()).toBeVisible({ timeout: UI_MS });
  // The approve's own side-effect failure is one delivery; reaching the run's end with the marker set is another.
  await expect.poll(async () => (await loopErrors()).length, { timeout: UI_MS }).toBe(2);
  await expect.poll(() => autoHaltReasons(home, repo), { timeout: UI_MS }).toEqual([['failed-effect']]);
  expect(auditGateEntries(home, repo).filter((e) => parseAutoHaltReasons(e.cmd) !== null).map((e) => gateDecisionDecider(e.cmd))).toEqual(['engine']);

  await dismissLoopErrors();
  await expect(flowControl()).toHaveText('Advance', { timeout: UI_MS });
  await flowControl().click();
  await expect.poll(() => flowState(repo), { timeout: UI_MS }).toMatch(/^status: done$/m);
  await page.evaluate((k) => window.flow.state(k), repo);
  expect(autoHaltReasons(home, repo)).toEqual([['failed-effect']]);
  expect(await loopErrors()).toHaveLength(2);
});

test('a relaunch keeps the run\'s authority: after a relaunch at a human gate, the run\'s later `auto` gate is engine-approved (N9b.8)', { tag: '@ownapp' }, async () => {
  test.setTimeout(2 * (WINDOW_TIMEOUT_MS + FIRST_PAINT_MS) + 2 * LOOP_ROUND_MS + 2 * APPROVE_ADVANCE_MS + 6 * UI_MS);
  const home = tmp('agent-term-e2e-137-relaunch-home-');
  const repo = seedAutoGateRepo('agent-term-e2e-137-relaunch-', 'groom', { ticket: '176' });
  cleanup.push(repo);
  seedTrustedFlow(home, repo, 'human-groom-auto-red', autoGateFlowYaml([
    { id: 'groom', kind: 'loop', loop: 'groom-loop', authority: 'human' },
    { id: 'red', kind: 'loop', loop: 'red-loop', authority: 'auto' },
    { id: 'done', kind: 'manual' },
  ]));
  const { stepId: _red, ...red } = redAgent();
  const agent = { groom: GROOM_AGENT, red };
  await launchInto('agent-term-e2e-137-relaunch-', repo, home, agent);

  await flowControl().click();
  await expect.poll(() => runState(repo), { timeout: LOOP_ROUND_MS }).toMatch(/^step: groom$[\s\S]*verdict: clean/m);
  await openLoopPanel();
  await expect(approveOption()).toBeVisible({ timeout: UI_MS });

  await app?.close();
  app = undefined;
  await launchInto('agent-term-e2e-137-relaunch-', repo, home, agent, {}, null);
  await openLoopPanel();
  await approveOption().click({ timeout: UI_MS });
  await expect.poll(() => flowState(repo), { timeout: APPROVE_ADVANCE_MS }).toMatch(/^step: red$/m);
  // The engine's approve replaces the clean `complete` run-state within the round, so only its result is polled.
  await expect.poll(() => flowState(repo), { timeout: LOOP_ROUND_MS + APPROVE_ADVANCE_MS }).toMatch(/^step: done$/m);

  const redDecisions = auditGateEntries(home, repo, { step: 'red' }).filter((e) => gateDecisionKind(e.cmd)?.kind === 'decision');
  expect(redDecisions.map((e) => gateDecisionDecider(e.cmd))).toEqual(['engine']);
  const groomDecisions = auditGateEntries(home, repo, { step: 'groom' }).filter((e) => gateDecisionKind(e.cmd)?.kind === 'decision');
  expect(groomDecisions.map((e) => gateDecisionDecider(e.cmd))).toEqual(['human']);
});

test('an `auto` gate the run had reached before a relaunch halts with (j) after it: the letter is shown, one engine (j) entry is recorded, and a human decides it (N9b.8)', { tag: '@ownapp' }, async () => {
  test.setTimeout(2 * (WINDOW_TIMEOUT_MS + FIRST_PAINT_MS) + LOOP_ROUND_MS + APPROVE_ADVANCE_MS + 6 * UI_MS);
  const home = tmp('agent-term-e2e-137-j-home-');
  const repo = seedAutoGateRepo('agent-term-e2e-137-j-', 'red');
  cleanup.push(repo);
  seedTrustedFlow(home, repo, 'auto-red', autoGateFlowYaml(AUTO_RED_THEN_MANUAL));
  const agent = redAgent([exampleConsolidatorOutput('stop for a human', loopRoster('red-loop'))]);
  await launchInto('agent-term-e2e-137-j-', repo, home, agent);

  await flowControl().click();
  await expect.poll(() => runState(repo), { timeout: LOOP_ROUND_MS }).toContain('verdict: stop for a human');
  await openLoopPanel();
  await expect(loopPanel().locator('[data-auto-halt-reason="stop-for-a-human"]')).toBeVisible({ timeout: UI_MS });

  await app?.close();
  app = undefined;
  await launchInto('agent-term-e2e-137-j-', repo, home, agent, {}, null);
  await openLoopPanel();
  await expect(loopPanel().locator('[data-auto-halt-reason="relaunched"]')).toBeVisible({ timeout: UI_MS });
  await expect(page.locator('#flow-strip .spill')).toHaveClass(/\bawait\b/, { timeout: UI_MS });
  expect(flowState(repo)).toMatch(/^step: red$/m);
  await expect.poll(() => autoHaltReasons(home, repo).filter((r) => r?.includes('relaunched')), { timeout: UI_MS }).toHaveLength(1);

  await approveOption().click({ timeout: UI_MS });
  await expect.poll(() => flowState(repo), { timeout: APPROVE_ADVANCE_MS }).toMatch(/^step: done$/m);
  const decisions = auditGateEntries(home, repo).filter((e) => gateDecisionKind(e.cmd)?.kind === 'decision');
  expect(decisions.map((e) => gateDecisionDecider(e.cmd))).toEqual(['human']);
});

test('a failed `gh` effect of an `auto` approve survives a relaunch before the next gate: that gate shows the marker and halts with (i) (AC15(iii), N9b.5(d), N9b.8)', { tag: '@ownapp' }, async () => {
  test.setTimeout(2 * (WINDOW_TIMEOUT_MS + FIRST_PAINT_MS) + 2 * LOOP_ROUND_MS + APPROVE_ADVANCE_MS + 6 * UI_MS);
  const home = tmp('agent-term-e2e-137-i-relaunch-home-');
  const repo = seedAutoGateRepo('agent-term-e2e-137-i-relaunch-', 'groom', { ticket: '176' });
  cleanup.push(repo);
  seedTrustedFlow(home, repo, 'auto-groom-red', autoGateFlowYaml([
    { id: 'groom', kind: 'loop', loop: 'groom-loop', authority: 'auto' },
    { id: 'red', kind: 'loop', loop: 'red-loop', authority: 'auto' },
    { id: 'done', kind: 'manual' },
  ]));
  const { stepId: _red, ...red } = redAgent();
  const { logFile } = await launchInto('agent-term-e2e-137-i-relaunch-', repo, home, { groom: GROOM_AGENT, red: { ...red, work: 'noop' } }, { FAKE_GH_FAIL_ACTION: 'update-issue-body' });

  await flowControl().click();
  await expect.poll(() => runState(repo), { timeout: LOOP_ROUND_MS + APPROVE_ADVANCE_MS }).toMatch(/^step: red$[\s\S]*status: working/m);
  expect(readIf(logFile)).toMatch(/gh issue edit/);

  await app?.close();
  app = undefined;
  await launchInto('agent-term-e2e-137-i-relaunch-', repo, home, { groom: GROOM_AGENT, red }, {}, null);
  await dismissLoopErrors();
  await openLoopPanel();
  await loopPanel().locator('[data-app-route-out="retry"]').click({ timeout: UI_MS });
  await expect.poll(() => runState(repo), { timeout: LOOP_ROUND_MS }).toMatch(/^step: red$[\s\S]*verdict: clean/m);
  await dismissLoopErrors();
  await openLoopPanel();
  await expect(loopPanel().locator('[data-failed-effect="set"]')).toBeVisible({ timeout: UI_MS });
  await expect(loopPanel().locator('[data-auto-halt-reason="failed-effect"]')).toBeVisible();
  expect(flowState(repo)).toMatch(/^step: red$/m);
  expect(auditGateEntries(home, repo, { step: 'red' }).filter((e) => gateDecisionKind(e.cmd)?.kind === 'decision')).toEqual([]);
  expect(autoHaltReasons(home, repo).filter((r) => r?.includes('failed-effect'))).toHaveLength(1);
});

test('restart keeps the run\'s auto authority: after a relaunch, Restart from `done` of an `auto` run engine-approves its clean gate again, with no (j) (N9b.2(c), N9b.8)', { tag: '@ownapp' }, async () => {
  test.setTimeout(2 * (WINDOW_TIMEOUT_MS + FIRST_PAINT_MS) + 2 * LOOP_ROUND_MS + 2 * APPROVE_ADVANCE_MS + 6 * UI_MS);
  const home = tmp('agent-term-e2e-137-restart-home-');
  const repo = seedAutoGateRepo('agent-term-e2e-137-restart-', 'red');
  cleanup.push(repo);
  seedTrustedFlow(home, repo, 'auto-red', autoGateFlowYaml(AUTO_RED_THEN_MANUAL));
  const agent = {
    ...redAgent(),
    writeTest: false,
    extraShell: { work: [`mkdir -p tests; printf '%s\\n' 'test("adds", () => { expect(1).toBe(2); });' > tests/red_$RANDOM$RANDOM.test.ts`] },
  };
  await launchInto('agent-term-e2e-137-restart-', repo, home, agent);

  await flowControl().click();
  await expect.poll(() => flowState(repo), { timeout: LOOP_ROUND_MS + APPROVE_ADVANCE_MS }).toMatch(/^step: done$/m);
  await expect(flowControl()).toHaveText('Advance', { timeout: UI_MS });
  await flowControl().click();
  await expect(flowControl()).toHaveText('Restart', { timeout: UI_MS });

  await app?.close();
  app = undefined;
  await launchInto('agent-term-e2e-137-restart-', repo, home, agent, {}, 'Restart');
  await flowControl().click();
  await expect.poll(() => flowState(repo), { timeout: APPROVE_ADVANCE_MS }).toMatch(/^step: red$/m);
  await expect
    .poll(() => flowState(repo), { timeout: LOOP_ROUND_MS + APPROVE_ADVANCE_MS })
    .toMatch(/^step: done$/m)
    .catch(failWithDiagnosis(home, repo));

  const entries = auditGateEntries(home, repo);
  const decisions = entries.filter((e) => gateDecisionKind(e.cmd)?.kind === 'decision');
  expect(decisions.map((e) => gateDecisionDecider(e.cmd))).toEqual(['engine', 'engine']);
  expect(entries.filter((e) => parseAutoHaltReasons(e.cmd) !== null)).toEqual([]);
});

// ── #137 S5: the shipped `feature-dev` authorities, end to end (AC16) ──

const FEATURE_DEV_YAML = readFileSync(join(process.cwd(), 'example', 'flows', 'feature-dev-v2', 'flow.yaml'), 'utf8');
const FEATURE_DEV_AUTO_GATES = 9;
const FEATURE_DEV_LOOP_RUNS = 11;

function seedFeatureDevRun(prefix: string, home: string): string {
  const repo = seedAutoGateRepo(prefix, 'groom', { ticket: '176' });
  cleanup.push(repo);
  seedTrustedFlow(home, repo, 'feature-dev-v2', FEATURE_DEV_YAML);
  return repo;
}

/** Wait, bounded, for `step`'s clean gate to wait on the operator; a halt or a stall fails naming what the gate shows. */
async function awaitHumanGate(home: string, repo: string, step: string, timeout: number): Promise<void> {
  const atGate = (): boolean => new RegExp(`^step: ${step}$`, 'm').test(flowState(repo)) && new RegExp(`^step: ${step}$[\\s\\S]*verdict: clean`, 'm').test(runState(repo));
  try {
    await expect.poll(atGate, { timeout }).toBe(true);
    await openLoopPanel();
    await expect(approveOption()).toBeVisible({ timeout: UI_MS });
  } catch (e) {
    const halts = await haltRows().evaluateAll((rows) => rows.map((r) => r.getAttribute('data-auto-halt-reason')));
    throw new Error(`no human gate at ${step}; halt reasons shown: ${JSON.stringify(halts)}\nflow-state.yaml:\n${flowState(repo)}\n${gateDiagnosis(home, repo)}\n${e instanceof Error ? e.message : String(e)}`);
  }
  expect(await haltRows().count()).toBe(0);
}

test('feature-dev run stops only at plan-polish and integration-slice: every other gate advances alone with its phase commit (AC16)', { tag: '@ownapp' }, async () => {
  test.setTimeout(WINDOW_TIMEOUT_MS + FIRST_PAINT_MS + FEATURE_DEV_LOOP_RUNS * (LOOP_ROUND_MS + APPROVE_ADVANCE_MS) + 6 * UI_MS);
  const home = tmp('agent-term-e2e-137-fdev-home-');
  const repo = seedFeatureDevRun('agent-term-e2e-137-fdev-', home);
  const baseline = gitIn(repo, 'rev-parse', 'HEAD');
  const { logFile } = await launchInto('agent-term-e2e-137-fdev-', repo, home, (binDir) => seedFullTddChainAgent(binDir, { implSlices: 2 }));

  await flowControl().click();

  await awaitHumanGate(home, repo, 'plan-polish', 3 * (LOOP_ROUND_MS + APPROVE_ADVANCE_MS));
  await approveOption().click();
  await expect.poll(() => flowState(repo), { timeout: APPROVE_ADVANCE_MS }).not.toMatch(/^step: plan-polish$/m);

  await awaitHumanGate(home, repo, 'integration-slice', 8 * LOOP_ROUND_MS + 7 * APPROVE_ADVANCE_MS);
  await approveOption().click();
  await expect.poll(() => flowState(repo), { timeout: APPROVE_ADVANCE_MS }).toMatch(/^step: finalize$/m);

  expect(gitIn(repo, 'log', '--format=%s', `${baseline}..HEAD`).split('\n')).toEqual(['integration', 'refactor', 'GREEN', 'RED', 'refactor', 'GREEN', 'RED', 'infra']);
  expect(readIf(logFile).split('\n').filter((l) => /^gh issue edit \S+ .*--body-file/.test(l))).toHaveLength(1);

  const entries = auditGateEntries(home, repo);
  const decisions = entries.filter((e) => gateDecisionKind(e.cmd)?.kind === 'decision');
  expect(decisions.filter((e) => gateDecisionDecider(e.cmd) === 'human')).toHaveLength(2);
  expect(decisions.filter((e) => gateDecisionDecider(e.cmd) === 'engine')).toHaveLength(FEATURE_DEV_AUTO_GATES);
  for (const step of ['plan-polish', 'integration-slice']) {
    const at = auditGateEntries(home, repo, { step }).filter((e) => gateDecisionKind(e.cmd)?.kind === 'decision');
    expect(at.map((e) => gateDecisionDecider(e.cmd)), step).toEqual(['human']);
  }
  expect(entries.filter((e) => gateDecisionKind(e.cmd)?.kind === 'auto-halt')).toEqual([]);
});

test('feature-dev auto step halts on stop-for-a-human: the shipped flow\'s `groom` gate names the reason and does not advance (AC16, AC2)', { tag: '@ownapp' }, async () => {
  test.setTimeout(loopTestBudget(4, 0));
  const home = tmp('agent-term-e2e-137-fdev-halt-home-');
  const repo = seedFeatureDevRun('agent-term-e2e-137-fdev-halt-', home);
  await launchInto('agent-term-e2e-137-fdev-halt-', repo, home, (binDir) => seedFullTddChainAgent(binDir, { verdicts: { groom: ['stop for a human'] } }));

  await flowControl().click();

  await expect.poll(() => runState(repo), { timeout: LOOP_ROUND_MS }).toMatch(/^step: groom$[\s\S]*verdict: stop for a human/m);
  await openLoopPanel();
  await expect(approveOption()).toBeVisible({ timeout: UI_MS });
  await expect.poll(() => autoHaltsAt(home, repo, 'groom').map((e) => parseAutoHaltReasons(e.cmd)), { timeout: UI_MS }).toEqual([['stop-for-a-human']]);
  await expect(loopPanel().locator('[data-auto-halt-reason="stop-for-a-human"]')).toBeVisible({ timeout: UI_MS });
  expect(flowState(repo)).toMatch(/^step: groom$/m);
  expect(auditGateEntries(home, repo).filter((e) => gateDecisionKind(e.cmd)?.kind === 'decision')).toEqual([]);
});

test('pinning: feature-dev full chain: auto advance, one visible halt, human-only gates (#137 integration)', { tag: '@ownapp' }, async () => {
  test.setTimeout(WINDOW_TIMEOUT_MS + FIRST_PAINT_MS + FEATURE_DEV_LOOP_RUNS * (LOOP_ROUND_MS + APPROVE_ADVANCE_MS) + 10 * UI_MS);
  const home = tmp('agent-term-e2e-137-fdev-full-home-');
  const repo = seedFeatureDevRun('agent-term-e2e-137-fdev-full-', home);
  const baseline = gitIn(repo, 'rev-parse', 'HEAD');
  const { logFile } = await launchInto('agent-term-e2e-137-fdev-full-', repo, home, (binDir) =>
    seedFullTddChainAgent(binDir, { implSlices: 2, verdicts: { green: ['clean', 'stop for a human'] } }),
  );

  await flowControl().click();

  await awaitHumanGate(home, repo, 'plan-polish', 3 * (LOOP_ROUND_MS + APPROVE_ADVANCE_MS));
  await approveOption().click();
  await expect.poll(() => flowState(repo), { timeout: APPROVE_ADVANCE_MS }).not.toMatch(/^step: plan-polish$/m);

  await expect
    .poll(() => (auditGateEntries(home, repo).some((e) => parseAutoHaltReasons(e.cmd) !== null) ? autoHaltsAt(home, repo, 'green').map((e) => parseAutoHaltReasons(e.cmd)) : null), {
      timeout: 5 * LOOP_ROUND_MS + 4 * APPROVE_ADVANCE_MS,
    })
    .toEqual([['stop-for-a-human']]);
  expect(gitIn(repo, 'log', '--format=%s', `${baseline}..HEAD`).split('\n')).toEqual(['RED', 'refactor', 'GREEN', 'RED', 'infra']);
  await openLoopPanel();
  await expect(loopPanel().locator('[data-auto-halt-reason="stop-for-a-human"]')).toBeVisible({ timeout: UI_MS });
  await expect(approveOption()).toBeVisible({ timeout: UI_MS });
  expect(flowState(repo)).toMatch(/^step: green$/m);
  await approveOption().click();
  await expect.poll(() => gitIn(repo, 'log', '-1', '--format=%s'), { timeout: APPROVE_ADVANCE_MS }).toBe('GREEN');

  await awaitHumanGate(home, repo, 'integration-slice', 2 * LOOP_ROUND_MS + APPROVE_ADVANCE_MS);
  await approveOption().click();
  await expect.poll(() => flowState(repo), { timeout: APPROVE_ADVANCE_MS }).toMatch(/^step: finalize$/m);

  expect(gitIn(repo, 'log', '--format=%s', `${baseline}..HEAD`).split('\n')).toEqual(['integration', 'refactor', 'GREEN', 'RED', 'refactor', 'GREEN', 'RED', 'infra']);
  expect(readIf(logFile).split('\n').filter((l) => /^gh issue edit \S+ .*--body-file/.test(l))).toHaveLength(1);

  const entries = auditGateEntries(home, repo);
  const decisions = entries.filter((e) => gateDecisionKind(e.cmd)?.kind === 'decision');
  expect(decisions.filter((e) => gateDecisionDecider(e.cmd) === 'human')).toHaveLength(3);
  expect(decisions.filter((e) => gateDecisionDecider(e.cmd) === 'engine')).toHaveLength(FEATURE_DEV_AUTO_GATES - 1);
  for (const step of ['plan-polish', 'integration-slice']) {
    const at = auditGateEntries(home, repo, { step }).filter((e) => gateDecisionKind(e.cmd)?.kind === 'decision');
    expect(at.map((e) => gateDecisionDecider(e.cmd)), step).toEqual(['human']);
  }
  const atGreen = auditGateEntries(home, repo, { step: 'green' }).filter((e) => gateDecisionKind(e.cmd)?.kind === 'decision');
  expect(atGreen.map((e) => gateDecisionDecider(e.cmd)), 'the second slice\'s green').toEqual(['human']);
  expect(entries.filter((e) => gateDecisionKind(e.cmd)?.kind === 'auto-halt').map((e) => parseAutoHaltReasons(e.cmd))).toEqual([['stop-for-a-human']]);
});

// ── #137 S3: concurrency at the gate — the interrupt, the decision bound, the epic preview ──

const ARMED_REL = '.agent-terminal/loop/armed-interrupt.yaml';

test('auto gate concurrency, interrupt: an arm made at an earlier `human` step that no consolidation consumed halts the `auto` step\'s clean gate with (c) and is consumed (AC11)', { tag: '@ownapp' }, async () => {
  test.setTimeout(loopTestBudget(10, 1) + 2 * LOOP_ROUND_MS);
  const home = tmp('agent-term-e2e-137-c-home-');
  const repo = seedAutoGateRepo('agent-term-e2e-137-c-', 'groom', { ticket: '176' });
  cleanup.push(repo);
  seedTrustedFlow(home, repo, 'human-groom-auto-red', autoGateFlowYaml([
    { id: 'groom', kind: 'loop', loop: 'groom-loop', authority: 'human' },
    { id: 'red', kind: 'loop', loop: 'red-loop', authority: 'auto' },
    { id: 'done', kind: 'manual' },
  ]));
  const sentinel = join(tmp('agent-term-e2e-137-c-hold-'), 'hold');
  writeFileSync(sentinel, '');
  const { stepId: _red, ...red } = redAgent();
  await launchInto('agent-term-e2e-137-c-', repo, home, {
    groom: { ...GROOM_AGENT, hold: { sentinel }, consolidateAttempts: [NO_VERDICT, NO_VERDICT] },
    red,
  }, STALL_ENV);
  const armFile = join(repo, ARMED_REL);

  await flowControl().click();

  await expect.poll(() => runState(repo), { timeout: LOOP_ROUND_MS }).toMatch(/^step: groom$[\s\S]*^status: working$/m);
  await openLoopPanel();
  await loopPanel().locator('[data-arm-interrupt]').click({ timeout: UI_MS });
  await expect.poll(() => readIf(armFile), { timeout: UI_MS }).toMatch(/^step: groom$/m);
  rmSync(sentinel, { force: true });

  await expect.poll(() => runState(repo), { timeout: LOOP_ROUND_MS }).toMatch(/^status: error$/m);
  await dismissLoopErrors();
  await openLoopPanel();
  await loopPanel().locator('[data-app-route-out="accept"]').click({ timeout: UI_MS });
  await expect.poll(() => runState(repo), { timeout: UI_MS }).toMatch(/^status: complete$/m);
  expect(existsSync(armFile)).toBe(true);
  await expect(flowControl()).toHaveText('Advance', { timeout: UI_MS });
  await flowControl().click();

  await expect.poll(() => flowState(repo), { timeout: APPROVE_ADVANCE_MS }).toMatch(/^step: red$/m);
  await expect
    .poll(() => runState(repo), { timeout: LOOP_ROUND_MS })
    .toMatch(/^step: red$[\s\S]*^status: complete$/m)
    .catch(failWithDiagnosis(home, repo));
  await dismissLoopErrors();
  await openLoopPanel();
  await expect(loopPanel().locator('[data-auto-halt-reason="interrupt-armed"]')).toBeVisible({ timeout: UI_MS });
  await expect.poll(() => existsSync(armFile), { timeout: UI_MS }).toBe(false);
  expect(flowState(repo)).toMatch(/^step: red$/m);
  expect(engineDecisions(home, repo)).toEqual([]);
});

test('auto gate concurrency, bound: an engine approve whose `gh` effect does not settle within APP_AUTO_GATE_DECISION_MS raises the human-needed alert (AC14)', { tag: '@ownapp' }, async () => {
  test.setTimeout(loopTestBudget(4, 0));
  const home = tmp('agent-term-e2e-137-bound-home-');
  const repo = seedAutoGateRepo('agent-term-e2e-137-bound-', 'groom', { ticket: '176' });
  cleanup.push(repo);
  seedTrustedFlow(home, repo, 'auto-groom-end', autoGateFlowYaml([
    { id: 'groom', kind: 'loop', loop: 'groom-loop', authority: 'auto' },
    { id: 'finalize', kind: 'manual' },
  ]));
  const sentinel = join(tmp('agent-term-e2e-137-bound-hold-'), 'hold');
  writeFileSync(sentinel, '');
  try {
    const { logFile } = await launchInto('agent-term-e2e-137-bound-', repo, home, { stepId: 'groom', ...GROOM_AGENT }, {
      APP_AUTO_GATE_DECISION_MS: '1500',
      FAKE_GH_HOLD: sentinel,
      FAKE_GH_HOLD_ACTION: 'update-issue-body',
    });

    await flowControl().click();

    await expect.poll(() => readIf(logFile), { timeout: LOOP_ROUND_MS }).toMatch(/^held \d+ gh issue edit/m);
    await expect(page.locator('#status-bar [data-status-alert]')).toBeVisible({ timeout: UI_MS });
    const gate = readGateRunState(repo);
    expect(gate.kind === 'ok' ? gate.state.failedEffect?.state : null).toBe('set');
    expect(autoHaltReasons(home, repo)).toEqual([]);
  } finally {
    rmSync(sentinel, { force: true });
  }
});

test('auto gate concurrency, bound fallback: APP_AUTO_GATE_DECISION_MS=-5 falls back to the default, so a held engine approve released at once advances with no halt and no failed-effect marker (AC14)', { tag: '@ownapp' }, async () => {
  test.setTimeout(loopTestBudget(2, 1));
  const home = tmp('agent-term-e2e-137-fallback-home-');
  const repo = seedAutoGateRepo('agent-term-e2e-137-fallback-', 'groom', { ticket: '176' });
  cleanup.push(repo);
  seedTrustedFlow(home, repo, 'auto-groom-end', autoGateFlowYaml([
    { id: 'groom', kind: 'loop', loop: 'groom-loop', authority: 'auto' },
    { id: 'finalize', kind: 'manual' },
  ]));
  const sentinel = join(tmp('agent-term-e2e-137-fallback-hold-'), 'hold');
  writeFileSync(sentinel, '');
  try {
    const { logFile } = await launchInto('agent-term-e2e-137-fallback-', repo, home, { stepId: 'groom', ...GROOM_AGENT }, {
      APP_AUTO_GATE_DECISION_MS: '-5',
      FAKE_GH_HOLD: sentinel,
      FAKE_GH_HOLD_ACTION: 'update-issue-body',
    });

    await flowControl().click();

    await expect.poll(() => readIf(logFile), { timeout: LOOP_ROUND_MS }).toMatch(/^held \d+ gh issue edit/m);
    rmSync(sentinel, { force: true });

    await expect.poll(() => flowState(repo), { timeout: APPROVE_ADVANCE_MS }).toMatch(/^step: finalize$/m);
    expect(engineDecisions(home, repo)).toHaveLength(1);
    expect(autoHaltReasons(home, repo)).toEqual([]);
    const gate = readGateRunState(repo);
    expect(gate.kind === 'ok' ? gate.state.failedEffect : null).toBeNull();
  } finally {
    rmSync(sentinel, { force: true });
  }
});

const PLAN_REL = '.agent-terminal/loop/artifacts/plan.md';

test('auto gate concurrency, epic preview: an `auto` plan-polish gate on an epic plan raises the confirm-first preview, shows (k), creates nothing, and the operator\'s confirm is human (AC9)', { tag: '@ownapp' }, async () => {
  test.setTimeout(loopTestBudget(8, 2) + LOOP_ROUND_MS);
  const home = tmp('agent-term-e2e-137-k-home-');
  const repo = seedAutoGateRepo('agent-term-e2e-137-k-', 'groom', { ticket: '176' });
  cleanup.push(repo);
  seedTrustedFlow(home, repo, 'human-groom-auto-plan-polish', autoGateFlowYaml([
    { id: 'groom', kind: 'loop', loop: 'groom-loop', authority: 'human' },
    { id: 'plan-polish', kind: 'loop', loop: 'plan-polish-loop', authority: 'auto' },
    { id: 'done', kind: 'manual' },
  ]));
  const epicPlan = `${exampleEpicPlan(2)}\n${completionMarker('plan-polish')}\n`;
  const { logFile } = await launchInto('agent-term-e2e-137-k-', repo, home, {
    groom: GROOM_AGENT,
    'plan-polish': {
      artifactRel: PLAN_REL,
      work: 'complete',
      roster: loopRoster('plan-polish-loop'),
      extraShell: { work: [`printf %s '${b64(epicPlan)}' | base64 -d > ${PLAN_REL}`] },
    },
  });

  await flowControl().click();

  await expect.poll(() => runState(repo), { timeout: LOOP_ROUND_MS }).toMatch(/^step: groom$[\s\S]*verdict: clean/m);
  await openLoopPanel();
  await approveOption().click({ timeout: UI_MS });
  await expect.poll(() => flowState(repo), { timeout: APPROVE_ADVANCE_MS }).toMatch(/^step: plan-polish$/m);
  await expect.poll(() => runState(repo), { timeout: LOOP_ROUND_MS }).toMatch(/^step: plan-polish$[\s\S]*verdict: clean/m);
  await dismissLoopErrors();
  await openLoopPanel();
  await expect(loopPanel().locator('[data-epic-preview]')).toBeVisible({ timeout: UI_MS });
  await expect(loopPanel().locator('[data-auto-halt-reason="epic-promotion"]')).toBeVisible({ timeout: UI_MS });
  expect(readIf(logFile)).not.toContain('issue create');
  expect(flowState(repo)).toMatch(/^step: plan-polish$/m);
  const run = runIdentity(repo);
  const previews = auditGateEntries(home, repo, { run }).filter((e) => gateDecisionKind(e.cmd)?.kind === 'epic-promotion-preview');
  expect(previews.map((e) => gateDecisionDecider(e.cmd))).toEqual(['engine']);

  const dialog = page.getByRole('alertdialog').filter({ hasText: 'Create sub-ticket' });
  await expect(dialog).toBeVisible({ timeout: UI_MS });
  await dialog.locator('.pill.danger.confirm').click();
  await expect.poll(() => readIf(logFile), { timeout: APPROVE_ADVANCE_MS }).toContain('issue create');
  await expect.poll(
    () => auditGateEntries(home, repo, { run }).filter((e) => gateDecisionKind(e.cmd)?.kind === 'confirm').map((e) => gateDecisionDecider(e.cmd)),
    { timeout: UI_MS },
  ).toEqual(['human']);
});

// #137 S4 — the approve-time frozen check held on the phase baseline (RED's phase commit) by the fake git's
// FAKE_GIT_HOLD, the only window before the engine's identity check and claim. The hold file is created only
// once GREEN's consolidate turn is running (held by the fake agent), after every turn-completion frozen read.
const AUTO_RED_THEN_AUTO_GREEN: AutoGateStep[] = [
  { id: 'red', kind: 'loop', loop: 'red-loop', authority: 'auto' },
  { id: 'green', kind: 'loop', loop: 'green-loop', authority: 'auto' },
  { id: 'done', kind: 'manual' },
];
const RUN_STATE_REL = '.agent-terminal/loop/run-state.yaml';
const heldNaming = (logFile: string, rev: string): boolean => readIf(logFile).split('\n').some((l) => /^held \d+ git /.test(l) && l.includes(rev));
const STEADY_MS = 2_000;
const STEADY_POLL_MS = 100;

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** Every `held <pid>` read the shim logged has exited, whether released, expired or aborted. */
const heldReadsDone = (logFile: string): boolean =>
  readIf(logFile).split('\n').flatMap((l) => /^held (\d+) /.exec(l)?.[1] ?? []).every((p) => !pidAlive(Number(p)));

/** Asserts `read()` equals `expected` throughout `STEADY_MS`, so a late write is seen rather than raced. */
async function expectSteady<T>(read: () => T, expected: T): Promise<void> {
  const end = Date.now() + STEADY_MS;
  do {
    expect(read() as unknown).toEqual(expected);
    await new Promise((r) => setTimeout(r, STEADY_POLL_MS));
  } while (Date.now() < end);
  expect(read() as unknown).toEqual(expected);
}

interface HeldGreen {
  home: string;
  repo: string;
  baseline: string;
  logFile: string;
  release: () => void;
}

async function startHeldGreen(prefix: string): Promise<HeldGreen> {
  const home = tmp(`${prefix}home-`);
  const repo = seedAutoGateRepo(prefix, 'red');
  cleanup.push(repo);
  seedTrustedFlow(home, repo, 'auto-red-auto-green', autoGateFlowYaml(AUTO_RED_THEN_AUTO_GREEN));
  const holdDir = tmp(`${prefix}hold-`);
  const sentinel = join(holdDir, 'consolidate');
  const gitHold = join(holdDir, 'git');
  writeFileSync(sentinel, '');
  const { stepId: _red, ...red } = redAgent();
  const { logFile } = await launchInto(prefix, repo, home, { red, green: greenAgent({ holdConsolidate: { sentinel } }) }, { FAKE_GIT_HOLD: gitHold });

  await flowControl().click();

  await expect
    .poll(() => {
      const rs = runState(repo);
      return /^step: green$/m.test(rs) && /^turn_key: consolidate-green$/m.test(rs) && /^status: working$/m.test(rs) && readIf(`${sentinel}.pids`).trim().length > 0;
    }, { timeout: 2 * LOOP_ROUND_MS + APPROVE_ADVANCE_MS })
    .toBe(true)
    .catch(failWithDiagnosis(home, repo));
  const baseline = gitIn(repo, 'rev-parse', 'HEAD');
  writeFileSync(gitHold, `${baseline}\n`);
  rmSync(sentinel, { force: true });

  await expect.poll(() => runState(repo), { timeout: LOOP_ROUND_MS }).toMatch(/^step: green$[\s\S]*^status: complete$/m);
  await openLoopPanel();
  await expect
    .poll(async () => heldNaming(logFile, baseline) || (await haltRows().count()) > 0, { timeout: UI_MS })
    .toBe(true)
    .catch(failWithDiagnosis(home, repo));
  return { home, repo, baseline, logFile, release: () => rmSync(gitHold, { force: true }) };
}

test('auto gate concurrency, held frozen check: a human approve during the held check wins over the engine (AC10)', { tag: '@ownapp' }, async () => {
  test.setTimeout(loopTestBudget(4, 2) + 2 * LOOP_ROUND_MS);
  const { home, repo, baseline, logFile, release } = await startHeldGreen('agent-term-e2e-137-human-first-');
  try {
    await approveOption().click({ timeout: UI_MS });
    await expect
      .poll(() => auditGateEntries(home, repo, { step: 'green' }).filter((e) => gateDecisionKind(e.cmd)?.kind === 'decision' && gateDecisionDecider(e.cmd) === 'human'), { timeout: APPROVE_ADVANCE_MS })
      .toHaveLength(1);
    await expect.poll(() => flowState(repo), { timeout: APPROVE_ADVANCE_MS }).toMatch(/^step: done$/m);
    recordChangedTests(repo, 'earlier-step', ['tests/earlier.test.ts']);
    await expect.poll(() => heldReadsDone(logFile), { message: 'the human approve aborts the held git read', timeout: UI_MS }).toBe(true);
  } finally {
    release();
  }

  await expect.poll(() => heldReadsDone(logFile), { timeout: UI_MS }).toBe(true);
  await expectSteady(() => auditGateEntries(home, repo, { step: 'green' }).filter((e) => gateDecisionDecider(e.cmd) === 'engine').map((e) => e.cmd), []);
  await expectSteady(() => readChangedTests(repo), { step: 'earlier-step', paths: ['tests/earlier.test.ts'] });
  expect(flowState(repo)).toMatch(/^status: in_progress$/m);
  const green = auditGateEntries(home, repo, { step: 'green' });
  expect(green.filter((e) => gateDecisionKind(e.cmd)?.kind === 'decision').map((e) => gateDecisionDecider(e.cmd))).toEqual(['human']);
  expect(heldNaming(logFile, baseline)).toBe(true);
});

test('auto gate concurrency, held frozen check: a rewritten run-state loop refuses the engine approve with (l) (AC13)', { tag: '@ownapp' }, async () => {
  test.setTimeout(loopTestBudget(4, 1) + 2 * LOOP_ROUND_MS);
  const { home, repo, baseline, logFile, release } = await startHeldGreen('agent-term-e2e-137-l-');
  const runStateFile = join(repo, RUN_STATE_REL);
  writeFileSync(runStateFile, readFileSync(runStateFile, 'utf8').replace(/^loop: .*$/m, 'loop: red-loop'));
  release();

  await expect
    .poll(() => autoHaltsAt(home, repo, 'green').flatMap((e) => parseAutoHaltReasons(e.cmd) ?? []), { timeout: APPROVE_ADVANCE_MS })
    .toContain('approve-not-persisted')
    .catch(failWithDiagnosis(home, repo));
  await expect(loopPanel().locator('[data-auto-halt-reason="approve-not-persisted"]')).toContainText('red-loop', { timeout: UI_MS });
  const green = auditGateEntries(home, repo, { step: 'green' });
  expect(green.filter((e) => gateDecisionKind(e.cmd)?.kind === 'side-effect')).toEqual([]);
  await expect.poll(() => heldReadsDone(logFile), { timeout: UI_MS }).toBe(true);
  await expectSteady(() => [autoHaltsAt(home, repo, 'green').length, gitIn(repo, 'rev-parse', 'HEAD')], [1, baseline]);
  expect(heldNaming(logFile, baseline)).toBe(true);
});

test('auto gate concurrency, held frozen check: an interrupt armed during the held check halts with (c) and (l) at the claim, and is consumed (N9b.5(c))', { tag: '@ownapp' }, async () => {
  test.setTimeout(loopTestBudget(4, 1) + 2 * LOOP_ROUND_MS);
  const { home, repo, baseline, logFile, release } = await startHeldGreen('agent-term-e2e-137-arm-held-');
  const armFile = join(repo, ARMED_REL);
  await page.evaluate(([repoKey]) => window.flow.armInterrupt(repoKey, 'green'), [repo] as const);
  await expect.poll(() => existsSync(armFile), { timeout: UI_MS }).toBe(true);
  release();

  await expect
    .poll(() => autoHaltsAt(home, repo, 'green').map((e) => [...(parseAutoHaltReasons(e.cmd) ?? [])].sort()), { timeout: APPROVE_ADVANCE_MS })
    .toEqual([['approve-not-persisted', 'interrupt-armed']])
    .catch(failWithDiagnosis(home, repo));
  await expect.poll(() => existsSync(armFile), { timeout: UI_MS }).toBe(false);
  await expect.poll(() => heldReadsDone(logFile), { timeout: UI_MS }).toBe(true);
  await expectSteady(() => [gitIn(repo, 'rev-parse', 'HEAD'), /^step: green$/m.test(flowState(repo))], [baseline, true]);
  expect(heldNaming(logFile, baseline)).toBe(true);
});
