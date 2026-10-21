import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createBenchFixtureBuilder, type BenchFixtureBuilder } from '../helpers/benchFixtureBuilder';
import { createBenchRoots, type BenchRoots } from '../helpers/benchRoots';
import { createFakeBenchGithub, FAKE_FIRST_COPY } from '../helpers/benchFakeGithub';
import { createFakeLauncher } from '../helpers/benchFakeLauncher';
import { runRequest } from '../helpers/benchRunSetup';
import { WINDOW_TIMEOUT_MS } from '../helpers/e2eBudget';
import { b64, exampleConfigDir, GOAL_CHECK_CMD, goalAgentOverruns, goalProgressCmd, readFakeGhIssue, seedFakeGhGit, seedFakeGhIssue, seedGoalSessionAgent, type FakeGhIssue, type GoalSessionScript } from './fakeTools';
import { BENCH_ENTRY } from '../../src/main/benchMain';
import { benchAppTarget, benchLaunchEnv } from '../../src/main/benchLauncher';
import { captureFixture } from '../../src/main/benchCapture';
import { runBench } from '../../src/main/benchRun';
import { BENCH_RUN_LABEL, createBenchGithub } from '../../src/main/benchGithub';
import type { AppLauncher } from '../../src/main/benchLauncher';
import { completionMarker } from '../../src/main/appWorkTurn';
import { BENCH_LAUNCH_ENV, BENCH_LAUNCH_SCHEMA, encodeBenchLaunch, parseBenchSpanEnd, type BenchLaunch } from '../../src/shared/benchLaunch';
import { BENCH_FIXTURE_MANIFEST, parseBenchFixture, type BenchFixtureRead } from '../../src/shared/benchFixture';
import { exampleSlicePlan } from '../../src/shared/slicePlan';
import type { StepSpan } from '../../src/shared/flowStepSpan';
import { createFlowStateStore } from '../../src/main/flowState';
import { shellQuote } from '../../src/shared/shellQuote';
import { APP_HOME_DIR_ENV, APP_LAUNCH_DIR_ENV } from '../../src/main/launchRoot';

// #180 — the built runner entry, run the way the `bench` script runs it: this checkout's electron in plain-Node
// mode on `out/main/<BENCH_ENTRY>.js`, argv only, temp homes, INIT_CWD naming the invoking directory, the gh-only
// fake first on PATH and real git; and the app the runner launches, opened the way its launcher opens it.

const V3_FLOW = readFileSync(join(process.cwd(), 'example', 'flows', 'feature-dev-v3', 'flow.yaml'), 'utf8');
const electronBinary = createRequire(join(process.cwd(), 'package.json'))('electron') as string;
const BUILT_APP_MAIN = join(process.cwd(), 'out', 'main', 'index.js');

let b: BenchFixtureBuilder | undefined;
let roots: BenchRoots | undefined;
let app: ElectronApplication | undefined;
const dirs: string[] = [];
test.afterEach(async () => {
  await app?.close();
  app = undefined;
  b?.cleanup();
  b = undefined;
  roots?.cleanup();
  roots = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const temp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  dirs.push(dir);
  return dir;
};

test('the bench script runs the built runner entry', { tag: '@ownapp' }, () => {
  const scripts = (JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;
  expect(scripts.bench ?? '').toContain(`out/main/${BENCH_ENTRY}.js`);
});

test('capture through the built entry writes a fixture the shared reader reads back', { tag: '@ownapp' }, () => {
  b = createBenchFixtureBuilder();
  const { dir: wf, commit } = b.makeRepository('bench-e2e-capture');
  b.seedFlow(wf, 'feature-dev-v3', V3_FLOW);
  createFlowStateStore(wf).write({ step: 'plan', status: 'not_started', inputs: { ticket: '180' } });
  b.writeArtifacts(wf, { 'groomed-ticket.md': '# groomed\n' });
  const { binDir, ghOnlyBinDir, logFile } = seedFakeGhGit('bench-e2e-gh-');
  dirs.push(binDir);
  const invoking = temp('bench-e2e-invoking');

  const run = spawnSync(electronBinary, [join(process.cwd(), 'out', 'main', `${BENCH_ENTRY}.js`), 'capture', relative(invoking, wf), 'fx'], {
    encoding: 'utf8',
    env: {
      PATH: `${ghOnlyBinDir}:${process.env.PATH}`,
      FAKE_GHGIT_LOG: logFile,
      ELECTRON_RUN_AS_NODE: '1',
      HOME: temp('bench-e2e-home'),
      [APP_HOME_DIR_ENV]: temp('bench-e2e-app-home'),
      CLAUDE_CONFIG_DIR: temp('bench-e2e-claude'),
      INIT_CWD: invoking,
      GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
      GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM,
    },
  });

  const manifest = join(invoking, 'fx', BENCH_FIXTURE_MANIFEST);
  const read: BenchFixtureRead | null = existsSync(manifest) ? parseBenchFixture(readFileSync(manifest, 'utf8')) : null;
  expect({ read, exit: run.status, output: `${run.stdout}${run.stderr}` }).toEqual({
    read: {
      ok: true,
      fixture: { schema_version: 1, commit, issue: { repository: 'github.com/fake/repo', number: 180 }, inputs: {}, repeat_counts: {} },
    },
    exit: 0,
    output: expect.any(String),
  });
});

interface EntryCommand {
  argv: string[];
  env: NodeJS.ProcessEnv;
  /** The log of the fake `gh` first on the entry's PATH, which also keys its issue store. */
  ghLog: string;
}

/** The built entry as the `bench` script runs it, from `invoking`, under temp homes, with `base` beneath. */
function entryCommand(args: string[], invoking: string, appHome: string, base: NodeJS.ProcessEnv = {}): EntryCommand {
  const { binDir, ghOnlyBinDir, logFile } = seedFakeGhGit('bench-e2e-gh-');
  dirs.push(binDir);
  return {
    argv: [join(process.cwd(), 'out', 'main', `${BENCH_ENTRY}.js`), ...args],
    env: {
      ...base,
      PATH: `${ghOnlyBinDir}:${process.env.PATH}`,
      FAKE_GHGIT_LOG: logFile,
      ELECTRON_RUN_AS_NODE: '1',
      HOME: temp('bench-e2e-home'),
      [APP_HOME_DIR_ENV]: appHome,
      CLAUDE_CONFIG_DIR: temp('bench-e2e-claude'),
      INIT_CWD: invoking,
      GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
      GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM,
    },
    ghLog: logFile,
  };
}

function runEntry(args: string[], invoking: string, appHome: string): ReturnType<typeof spawnSync> {
  const cmd = entryCommand(args, invoking, appHome);
  return spawnSync(electronBinary, cmd.argv, { encoding: 'utf8', env: cmd.env });
}

/** The pid, argv and launch dir of each process, other than Chromium's own children, whose env names a folder under
 *  `root`: the launched app and whatever it spawned with its env. */
function appsLaunchedUnder(root: string): { pid: number; args: string[]; launchDir: string }[] {
  const found: { pid: number; args: string[]; launchDir: string }[] = [];
  for (const name of readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
    try {
      const args = readFileSync(join('/proc', name, 'cmdline'), 'utf8').split('\0');
      if (args.some((a) => a.startsWith('--type='))) continue;
      const launchDir = readFileSync(join('/proc', name, 'environ'), 'utf8')
        .split('\0')
        .find((e) => e.startsWith(`${APP_LAUNCH_DIR_ENV}=`))
        ?.slice(APP_LAUNCH_DIR_ENV.length + 1);
      if (launchDir?.startsWith(`${root}/`)) found.push({ pid: Number(name), args, launchDir });
    } catch {
      continue;
    }
  }
  return found;
}

function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig);
  } catch {
    return;
  }
}

test('run through the built entry refuses an unparsable fixture with its code and creates no run folder', { tag: '@ownapp' }, () => {
  b = createBenchFixtureBuilder();
  const { dir: repo } = b.makeRepository('bench-e2e-run');
  b.seedFlow(repo, 'feature-dev-v3', V3_FLOW);
  const fixture = join(temp('bench-e2e-fx'), 'fx');
  b.writeHandFixture(fixture, {}, {});
  writeFileSync(join(fixture, BENCH_FIXTURE_MANIFEST), '{ "schema_version": 1, ');
  const appHome = temp('bench-e2e-app-home');

  const run = runEntry(['run', '--flow', 'feature-dev-v3', '--span', 'plan', '--fixture', fixture, '--runs', '1'], repo, appHome);

  const output = `${run.stdout}${run.stderr}`;
  expect({ failed: run.status !== 0, namesCode: output.includes('fixture-unparsable'), appHome: readdirSync(appHome), output }).toEqual({
    failed: true,
    namesCode: true,
    appHome: [],
    output: expect.any(String),
  });
});

test('run through the built entry opens the app at the prepared folder, waits for it to exit, and prints its run folder', { tag: '@ownapp' }, async () => {
  test.skip(process.platform !== 'linux', 'reads the launched app from /proc: the Podman harness');
  b = createBenchFixtureBuilder();
  const { dir: repo, commit } = b.makeRepository('bench-e2e-run-launch');
  b.seedFlow(repo, 'feature-dev-v3', V3_FLOW);
  const fixture = join(temp('bench-e2e-run-launch-fx'), 'fx');
  b.writeHandFixture(fixture, { commit, phase_baseline: undefined, issue: { repository: 'github.com/fake/repo', number: 180 } }, { 'groomed-ticket.md': '# groomed\n' });
  const appHome = realpathSync(temp('bench-e2e-run-launch-app-home'));
  const cmd = entryCommand(['run', '--flow', 'feature-dev-v3', '--span', 'plan', '--fixture', fixture, '--runs', '1'], repo, appHome, { ...process.env, APP_SHELL: 'bash' });
  seedFakeGhIssue(cmd.ghLog, { number: 180, title: 'Bench-1', body: 'The intent.\n', labels: ['agent-loop/ready'], comments: [] });

  const runner = spawn(electronBinary, cmd.argv, { env: cmd.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  runner.stdout.on('data', (d: Buffer) => (output += d.toString()));
  runner.stderr.on('data', (d: Buffer) => (output += d.toString()));
  const exited = new Promise<number | null>((done) => runner.on('exit', (code) => done(code)));
  let runnerExit: number | null | undefined;
  void exited.then((code) => (runnerExit = code));

  let launched: { pid: number; args: string[]; launchDir: string }[] = [];
  let runnerWaiting = false;
  let exit: number | null | 'still running';
  try {
    for (const deadline = Date.now() + 20_000; launched.length === 0 && runnerExit === undefined && Date.now() < deadline; ) {
      await new Promise((r) => setTimeout(r, 250));
      launched = appsLaunchedUnder(appHome).filter(({ args }) => args.includes(BUILT_APP_MAIN));
    }
    // An app that dies at startup can still be caught by one poll, so it must be running a poll later.
    await new Promise((r) => setTimeout(r, 250));
    const running = appsLaunchedUnder(appHome).map(({ pid }) => pid);
    runnerWaiting = launched.length > 0 && launched.every(({ pid }) => running.includes(pid)) && runnerExit === undefined;
    for (const { pid } of launched) signal(pid, 'SIGTERM');
    exit = await Promise.race([exited, new Promise<'still running'>((r) => setTimeout(() => r('still running'), 20_000))]);
  } finally {
    for (const { pid } of appsLaunchedUnder(appHome)) signal(pid, 'SIGKILL');
    if (runnerExit === undefined) runner.kill('SIGKILL');
  }

  const launchDir = launched[0]?.launchDir ?? null;
  expect({
    launches: launched.length,
    runnerWaiting,
    launchDirIsRepo: launchDir !== null && existsSync(join(launchDir, '.git')),
    exit,
    printed: output.split('\n').filter((l) => l !== '' && launchDir?.startsWith(`${l}/`)).length,
    output,
  }).toEqual({
    launches: 1,
    runnerWaiting: true,
    launchDirIsRepo: true,
    exit: 0,
    printed: 1,
    output: expect.any(String),
  });
});

test('the app the runner launches is this checkout\'s build, at the bundle the runner reads its revision from', { tag: '@ownapp' }, async () => {
  b = createBenchFixtureBuilder();
  const { dir: folder } = b.makeRepository('bench-e2e-launch');
  const target = benchAppTarget(electronBinary, join(process.cwd(), 'out', 'main'));
  const runDir = temp('bench-e2e-launch-run');
  const launch = { schema_version: BENCH_LAUNCH_SCHEMA, workingFolder: realpathSync(folder), span: { first: 'plan', last: 'plan' }, spanEndFile: join(runDir, 'span-end.json') };
  const home = temp('bench-e2e-launch-home');
  const env = benchLaunchEnv({ ...process.env, APP_SHELL: 'bash', HOME: home, [APP_HOME_DIR_ENV]: home }, launch);

  app = await electron.launch({
    executablePath: target.invocation.execPath,
    args: [...target.invocation.appArgs, `--user-data-dir=${temp('bench-e2e-launch-ud')}`],
    env: Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined)),
  });

  const appPath = await app.evaluate(({ app: a }) => a.getAppPath());
  expect(target.bundle).toEqual({ packaged: false, appPath });
});

// ---- the app side of the launch contract: the span guard, each ending the app writes, and the launch value ----

const ART = '.agent-terminal/loop/artifacts';
const writeArt = (file: string, lines: string[]): string => `mkdir -p ${ART}; printf '%s\\n' ${lines.map((l) => `'${l}'`).join(' ')} > ${ART}/${file}`;
const GROOMED = { 'groomed-ticket.md': '# Groomed ticket 180\n', 'groom-intent.md': '## MVP\n## Decision boundary\n' };
const definedEnv = (env: NodeJS.ProcessEnv): Record<string, string> => Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined));
const readIf = (p: string): string => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const flowStateOf = (wf: string): string => readIf(join(wf, '.agent-terminal', 'flow-state.yaml'));
const runStateOf = (wf: string): string => readIf(join(wf, '.agent-terminal', 'loop', 'run-state.yaml'));

let page: Page;
const termRows = () => page.locator('.xterm-rows');
const flowControl = () => page.locator('#flow-strip .flow-control');
const loopReadout = () => page.locator('#flow-strip .loopstat');
const loopPanel = () => page.locator('#loop-panel');

async function typeCommand(cmd: string): Promise<void> {
  await page.locator('.xterm-screen').click();
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe('TEXTAREA');
  await page.keyboard.type(cmd, { delay: 20 });
  await page.keyboard.press('Enter');
}

/** Waits until `done()` holds or `ms` pass, whichever is first; the test's own checks then grade what happened. */
async function until(done: () => boolean, ms: number): Promise<void> {
  for (const end = Date.now() + ms; !done() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 250));
}

/** The ending the span-end file names, `unparsable` when no reader reads it, null when there is none. */
function spanEnding(launch: BenchLaunch): string | null {
  if (!existsSync(launch.spanEndFile)) return null;
  const read = parseBenchSpanEnd(readFileSync(launch.spanEndFile, 'utf8'));
  return read.ok ? read.ending : 'unparsable';
}

interface PreparedRun {
  launch: BenchLaunch;
  /** The combined fake gh/git the launched app finds first on PATH, and the fake agent's home. */
  binDir: string;
  logFile: string;
}

/** A working folder the runner prepared for `span`, from a fixture captured of a feature-dev-v3 folder working issue
 *  180 and holding `artifacts`, and the launch value the runner opens the app with. A span holding pickup takes the
 *  fake git whose branch read follows its own checkout, as pickup checks the worktree is on the branch it made. */
async function preparedRun(span: StepSpan, artifacts: Record<string, string>, fakeGit: { realCommitOps: boolean }): Promise<PreparedRun> {
  b = createBenchFixtureBuilder();
  roots = createBenchRoots();
  const { dir: repo } = b.makeRepository('bench-e2e-span');
  b.seedFlow(repo, 'feature-dev-v3', V3_FLOW);
  createFlowStateStore(repo).write({ step: span.first, status: 'not_started', inputs: { ticket: '180' } });
  b.writeArtifacts(repo, artifacts);
  const fixture = join(temp('bench-e2e-span-fx'), 'fx');
  const captured = await captureFixture({ workingFolder: repo, fixtureDir: fixture, appHome: roots.appHome, github: createFakeBenchGithub() });
  if (!captured.ok) throw new Error(`setup: capture refused (${captured.code})`);
  let launch: BenchLaunch | undefined;
  const result = await runBench(runRequest({ repo, fixture }, roots, { span }, { launcher: createFakeLauncher({ inspect: (l) => (launch = l) }) }));
  if (!result.ok || launch === undefined) throw new Error(`setup: the run was not prepared (${result.ok ? 'no launch' : result.code})`);
  const { binDir, logFile } = seedFakeGhGit('bench-e2e-span-bin-', fakeGit);
  dirs.push(binDir);
  return { launch, binDir, logFile };
}

/** Opens this checkout's app the way the runner's launcher does, with `run`'s launch value; `closed()` reports
 *  whether the app has since exited. */
async function openLaunched(run: PreparedRun, extra: Record<string, string> = {}): Promise<{ closed: () => boolean }> {
  const base = { ...process.env, APP_SHELL: 'bash', HOME: roots!.home, [APP_HOME_DIR_ENV]: roots!.appHome, CLAUDE_CONFIG_DIR: exampleConfigDir, APP_SUBMIT_DELAY_MS: '100', PATH: `${run.binDir}:${process.env.PATH}`, FAKE_GHGIT_LOG: run.logFile, ...extra };
  app = await electron.launch({ args: [BUILT_APP_MAIN, `--user-data-dir=${temp('bench-e2e-span-ud')}`], env: definedEnv(benchLaunchEnv(base, run.launch)) });
  let closed = false;
  app.once('close', () => (closed = true));
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });
  return { closed: () => closed };
}

async function startWith(agent: string): Promise<void> {
  await expect(flowControl()).toHaveText('Start', { timeout: 30_000 });
  await typeCommand(agent);
  await flowControl().click();
}

const goalSteps = (wf: string): string[] =>
  readIf(join(wf, '.agent-terminal', 'goal-commands-seen'))
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => /turn-done:work-([a-z0-9-]+)/.exec(l)?.[1] ?? l);

test('span plan from a fixture captured after groom-approve starts plan with the fixture\'s documents and the issue copy, and the app exits on its own instead of entering plan-approve', { tag: '@ownapp' }, async () => {
  test.setTimeout(150_000);
  const run = await preparedRun({ first: 'plan', last: 'plan' }, GROOMED, { realCommitOps: false });
  const plan =
    `printf %s '${b64(`# plan\n\n${exampleSlicePlan(2)}\n${completionMarker('plan')}\n`)}' | base64 -d > ${ART}/plan.md; ` +
    `${writeArt('plan-report.md', ['## Needs your call', 'None.', '## Planner decisions', '1. kept', '## Review history', 'no findings'])}; ${goalProgressCmd('done')}; ${GOAL_CHECK_CMD}`;
  const script: GoalSessionScript = { goal: { plan: [plan] } };
  seedGoalSessionAgent(run.binDir, 'fake-agent', script);
  const wf = run.launch.workingFolder;
  const { closed } = await openLaunched(run);

  await startWith('fake-agent');
  // Ends when the app has closed, or once a plan-approve turn has reached the agent: the move that leaves the span
  // has then played out in full.
  await until(() => closed() || goalAgentOverruns(run.binDir).length > 0, 120_000);

  const prompt = readIf(join(wf, '.agent-terminal', 'goal-prompt-seen.md'));
  expect.soft(prompt).toContain(`  - groomed-ticket: ${ART}/groomed-ticket.md`);
  expect.soft(prompt).toContain(`  - groom-intent: ${ART}/groom-intent.md`);
  expect.soft(prompt).toContain(`TICKET — this loop is working GitHub issue #${FAKE_FIRST_COPY}.`);
  expect.soft(readIf(run.logFile)).toContain(`plan-loop/issue-${FAKE_FIRST_COPY}`);
  expect.soft(goalSteps(wf)).toEqual(['plan']);
  expect.soft(goalAgentOverruns(run.binDir)).toEqual([]);
  expect.soft(runStateOf(wf)).not.toContain('step: plan-approve');
  expect.soft({ closed: closed(), ending: spanEnding(run.launch) }).toEqual({ closed: true, ending: 'left span' });
});

test('span groom..groom-approve ends when the operator approves groom-approve: the app exits on its own, the flow still at groom-approve, nothing pushed and no PR opened', { tag: '@ownapp' }, async () => {
  test.setTimeout(150_000);
  const run = await preparedRun({ first: 'groom', last: 'groom-approve' }, { 'groom-intent.md': GROOMED['groom-intent.md'] }, { realCommitOps: true });
  const groom =
    `${writeArt('groomed-ticket.md', [`# Groomed ticket ${FAKE_FIRST_COPY}`, completionMarker('groom')])}; ` +
    `${writeArt('groom-report.md', ['## Needs your call', 'None.', '## Groomer decisions', '1. kept', '## Review history', 'no findings'])}; ${goalProgressCmd('done')}; ${GOAL_CHECK_CMD}`;
  const summary = writeArt('groom-summary.md', ['## Needs your call', 'None.', completionMarker('groom-approve')]);
  seedGoalSessionAgent(run.binDir, 'fake-agent', { goal: { groom: [groom] }, work: { 'groom-approve': [summary] } });
  const wf = run.launch.workingFolder;
  const { closed } = await openLaunched(run);

  await startWith('fake-agent');
  await expect.poll(() => runStateOf(wf), { timeout: 90_000 }).toMatch(/step: groom-approve[\s\S]*verdict: clean/);
  if ((await loopReadout().getAttribute('aria-expanded')) !== 'true') await loopReadout().click();
  await loopPanel().locator('[data-gate-option="approve"]').click();
  // Ends when the app has closed, or once pickup has opened its PR: the move into plan has then played out in full.
  await until(() => closed() || readIf(run.logFile).includes('gh pr create'), 60_000);

  expect.soft({ closed: closed(), ending: spanEnding(run.launch) }).toEqual({ closed: true, ending: 'left span' });
  expect.soft(flowStateOf(wf)).toContain('step: groom-approve\n');
  const calls = readIf(run.logFile);
  expect.soft({ pushed: calls.includes('git push'), prCreated: calls.includes('gh pr create') }).toEqual({ pushed: false, prCreated: false });
});

const SOURCE_ISSUE: FakeGhIssue = {
  number: 180,
  title: 'Bench-1: re-run a span',
  body: 'The intent.\n\nSee #178.\n',
  labels: ['agent-loop/ready', 'area/bench'],
  comments: [{ author: 'octocat', createdAt: '2026-01-02T03:04:05Z', body: 'A comment.\nSecond line.' }],
};

/** The issue numbers each logged `gh issue|pr` write names as a positional; every flag the app and the runner pass
 *  takes a value, and no title or value here is a bare number. */
function issuesWritten(calls: string[]): number[] {
  return calls.flatMap((call) => {
    const [, kind, sub, ...rest] = call.split(' ');
    if ((kind !== 'issue' && kind !== 'pr') || sub === 'view' || sub === 'list') return [];
    return rest.filter((t, i) => /^\d+$/.test(t) && !rest[i - 1]?.startsWith('-')).map(Number);
  });
}

const ghCalls = (logFile: string): string[] => readIf(logFile).split('\n').filter((l) => l.startsWith('gh '));

test('two runs of span groom..groom-approve from one fixture each work their own issue copy: every gh write of run k names run k\'s copy, the source is unchanged, and both runs read the same ticket text', { tag: '@ownapp' }, async () => {
  test.setTimeout(330_000);
  b = createBenchFixtureBuilder();
  roots = createBenchRoots();
  const { dir: repo } = b.makeRepository('bench-e2e-two');
  b.seedFlow(repo, 'feature-dev-v3', V3_FLOW);
  createFlowStateStore(repo).write({ step: 'groom', status: 'not_started', inputs: { ticket: '180' } });
  b.writeArtifacts(repo, { 'groom-intent.md': GROOMED['groom-intent.md'] });
  const { binDir, ghOnlyBinDir, logFile } = seedFakeGhGit('bench-e2e-two-bin-', { realCommitOps: true });
  dirs.push(binDir);
  seedFakeGhIssue(logFile, SOURCE_ISSUE);
  const fixture = join(temp('bench-e2e-two-fx'), 'fx');

  const savedPath = process.env.PATH;
  const savedLog = process.env.FAKE_GHGIT_LOG;
  const runs: { launch: BenchLaunch; copy: number; groomed: string; callsBefore: number; callsAfter: number; overruns: string[] }[] = [];
  const launcher: AppLauncher = {
    async open(launch) {
      const callsBefore = runs.at(-1)?.callsAfter ?? 0;
      const copy = Number(createFlowStateStore(launch.workingFolder).read()?.inputs?.ticket);
      const groomed = `# Groomed ticket, run ${runs.length + 1}\n${completionMarker('groom')}\n`;
      const agentDir = temp('bench-e2e-two-agent');
      const groom = `printf %s '${b64(groomed)}' | base64 -d > ${ART}/groomed-ticket.md; ` +
        `${writeArt('groom-report.md', ['## Needs your call', 'None.', '## Groomer decisions', '1. kept', '## Review history', 'no findings'])}; ${goalProgressCmd('done')}; ${GOAL_CHECK_CMD}`;
      const summary = writeArt('groom-summary.md', ['## Needs your call', 'None.', completionMarker('groom-approve')]);
      seedGoalSessionAgent(agentDir, 'fake-agent', { goal: { groom: [groom] }, work: { 'groom-approve': [summary] }, recordTicket: true });
      const { closed } = await openLaunched({ launch, binDir, logFile }, { PATH: `${agentDir}:${binDir}:${savedPath}` });

      await startWith('fake-agent');
      await expect.poll(() => runStateOf(launch.workingFolder), { timeout: 90_000 }).toMatch(/step: groom-approve[\s\S]*verdict: clean/);
      if ((await loopReadout().getAttribute('aria-expanded')) !== 'true') await loopReadout().click();
      await loopPanel().locator('[data-gate-option="approve"]').click();
      await until(closed, 60_000);
      if (!closed()) await app?.close();
      app = undefined;
      runs.push({ launch, copy, groomed, callsBefore, callsAfter: ghCalls(logFile).length, overruns: goalAgentOverruns(agentDir) });
    },
  };

  // The runner's gh is the gh-only fake over the same store and log; its git stays real.
  let result: Awaited<ReturnType<typeof runBench>>;
  try {
    process.env.PATH = `${ghOnlyBinDir}:${savedPath}`;
    process.env.FAKE_GHGIT_LOG = logFile;
    const captured = await captureFixture({ workingFolder: repo, fixtureDir: fixture, appHome: roots.appHome, github: createBenchGithub() });
    if (!captured.ok) throw new Error(`setup: capture refused (${captured.code})`);
    result = await runBench(runRequest({ repo, fixture }, roots, { span: { first: 'groom', last: 'groom-approve' }, runs: '2' }, { github: createBenchGithub(), launcher }));
  } finally {
    process.env.PATH = savedPath;
    if (savedLog === undefined) delete process.env.FAKE_GHGIT_LOG;
    else process.env.FAKE_GHGIT_LOG = savedLog;
  }

  const calls = ghCalls(logFile);
  const ticketSeen = runs.map(({ launch }) => readIf(join(launch.workingFolder, '.agent-terminal', 'ticket-seen.groom.txt')));
  const copies = runs.map(({ copy }) => readFakeGhIssue(logFile, copy));
  expect.soft({ ok: result.ok, runs: runs.length, distinctCopies: new Set(runs.map((r) => r.copy)).size }).toEqual({ ok: true, runs: 2, distinctCopies: 2 });
  expect.soft(runs.map(({ launch, overruns }) => ({ ending: spanEnding(launch), overruns }))).toEqual([
    { ending: 'left span', overruns: [] },
    { ending: 'left span', overruns: [] },
  ]);
  expect.soft(readFakeGhIssue(logFile, SOURCE_ISSUE.number)).toEqual(SOURCE_ISSUE);
  expect.soft(issuesWritten(calls)).not.toContain(SOURCE_ISSUE.number);
  for (const [k, run] of runs.entries()) {
    const written = issuesWritten(calls.slice(run.callsBefore, run.callsAfter));
    expect.soft({ run: k + 1, writes: written.length > 0, others: written.filter((n) => n !== run.copy) }).toEqual({ run: k + 1, writes: true, others: [] });
    const copied = copies[k];
    expect.soft({ title: copied?.title, body: copied?.body, labels: copied?.labels }).toEqual({ title: SOURCE_ISSUE.title, body: run.groomed, labels: ['area/bench', BENCH_RUN_LABEL] });
    const [author, ...text] = (copied?.comments[0]?.body ?? '').split('\n');
    expect.soft({ comments: copied?.comments.length, namesAuthor: author.includes(SOURCE_ISSUE.comments[0].author) && author.includes(SOURCE_ISSUE.comments[0].createdAt), mentions: author.includes('@'), verbatim: text.join('\n').endsWith(SOURCE_ISSUE.comments[0].body) })
      .toEqual({ comments: 1, namesAuthor: true, mentions: false, verbatim: true });
  }
  expect.soft(ticketSeen[0]).toContain(SOURCE_ISSUE.body);
  expect.soft(ticketSeen[0]).toContain(SOURCE_ISSUE.comments[0].body);
  expect.soft(ticketSeen[1]).toBe(ticketSeen[0]);
});

test('a launched run the operator terminates makes the app exit on its own, the span terminated', { tag: '@ownapp' }, async () => {
  test.setTimeout(120_000);
  const run = await preparedRun({ first: 'plan', last: 'plan' }, GROOMED, { realCommitOps: false });
  seedGoalSessionAgent(run.binDir, 'fake-agent', {});
  const wf = run.launch.workingFolder;
  const { closed } = await openLaunched(run);

  await startWith('fake-agent');
  await expect.poll(() => goalSteps(wf), { timeout: 60_000 }).toEqual(['plan']);
  await page.locator('#flow-strip .flow-terminate').click();
  const confirm = page.locator('#flow-confirm-host .flow-modal');
  await expect(confirm).toBeVisible({ timeout: 10_000 });
  await confirm.locator('.confirm').click();
  await until(closed, 30_000);

  expect({ closed: closed(), ending: spanEnding(run.launch) }).toEqual({ closed: true, ending: 'terminated' });
});

test('the operator closing a launched app\'s window ends the span as window closed', { tag: '@ownapp' }, async () => {
  const run = await preparedRun({ first: 'plan', last: 'plan' }, GROOMED, { realCommitOps: false });
  const { closed } = await openLaunched(run);
  // The window close is app-wide: it ends the span from whatever folder the shell is in.
  await typeCommand(`cd ${shellQuote(b!.makeRepository('bench-e2e-elsewhere').dir)}`);
  await expect(page.getByRole('button', { name: 'Flow: default' })).toBeVisible({ timeout: 15_000 });

  await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  await until(closed, 30_000);

  expect({ closed: closed(), ending: spanEnding(run.launch) }).toEqual({ closed: true, ending: 'window closed' });
});

test('a launched app whose shell exits quits with no span-end file, so the runner records app exited', { tag: '@ownapp' }, async () => {
  const run = await preparedRun({ first: 'plan', last: 'plan' }, GROOMED, { realCommitOps: false });
  const { closed } = await openLaunched(run, { APP_STARTUP_EXIT_GRACE_MS: '1' });

  // The app closes as the shell exits, so the Enter that ends `exit` may find the page gone.
  await typeCommand('exit').catch(() => undefined);
  await until(closed, 30_000);

  expect({ closed: closed(), ending: spanEnding(run.launch) }).toEqual({ closed: true, ending: null });
});

for (const [why, code, value] of [
  ['does not decode', 'launch-undecodable', (): string => '{ "schema_version": 1, '],
  ['names another folder than the one it opens', 'launch-folder-mismatch', (other: string, runDir: string): string =>
    encodeBenchLaunch({ schema_version: BENCH_LAUNCH_SCHEMA, workingFolder: other, span: { first: 'plan', last: 'plan' }, spanEndFile: join(runDir, 'span-end.json') })],
] as const) {
  test(`the app launched with a launch value that ${why} exits non-zero with ${code} before it starts its shell`, { tag: '@ownapp' }, async () => {
    b = createBenchFixtureBuilder();
    const folder = realpathSync(b.makeRepository('bench-e2e-contract').dir);
    const other = realpathSync(temp('bench-e2e-contract-other'));
    const runDir = temp('bench-e2e-contract-run');
    const marker = join(runDir, 'shell-started');
    const shell = join(runDir, 'shell.sh');
    writeFileSync(shell, `#!/bin/sh\n: > ${shellQuote(marker)}\nexec bash "$@"\n`, { mode: 0o755 });
    const home = temp('bench-e2e-contract-home');
    const { invocation } = benchAppTarget(electronBinary, join(process.cwd(), 'out', 'main'));
    const child = spawn(invocation.execPath, [...invocation.appArgs, `--user-data-dir=${temp('bench-e2e-contract-ud')}`], {
      env: { ...process.env, APP_SHELL: shell, HOME: home, [APP_HOME_DIR_ENV]: home, [APP_LAUNCH_DIR_ENV]: folder, [BENCH_LAUNCH_ENV]: value(other, runDir) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (d: Buffer) => (output += d.toString()));
    child.stderr.on('data', (d: Buffer) => (output += d.toString()));
    const exited = new Promise<number | null>((done) => child.on('exit', (c) => done(c)));
    let exit: number | null | 'still running';
    try {
      exit = await Promise.race([exited, new Promise<'still running'>((r) => setTimeout(() => r('still running'), 20_000))]);
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
    }

    expect({ exit: typeof exit === 'number' && exit !== 0 ? 'non-zero' : exit, namesCode: output.includes(code), shellStarted: existsSync(marker), output }).toEqual({
      exit: 'non-zero',
      namesCode: true,
      shellStarted: false,
      output: expect.any(String),
    });
  });
}

test('the shell a launched app starts carries neither the launch value nor the launch folder', { tag: '@ownapp' }, async () => {
  b = createBenchFixtureBuilder();
  const folder = realpathSync(b.makeRepository('bench-e2e-shell-env').dir);
  const runDir = temp('bench-e2e-shell-env-run');
  const launch: BenchLaunch = { schema_version: BENCH_LAUNCH_SCHEMA, workingFolder: folder, span: { first: 'plan', last: 'plan' }, spanEndFile: join(runDir, 'span-end.json') };
  const home = temp('bench-e2e-shell-env-home');
  app = await electron.launch({
    args: [BUILT_APP_MAIN, `--user-data-dir=${temp('bench-e2e-shell-env-ud')}`],
    env: definedEnv(benchLaunchEnv({ ...process.env, APP_SHELL: 'bash', HOME: home, [APP_HOME_DIR_ENV]: home, APP_SUBMIT_DELAY_MS: '100' }, launch)),
  });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });
  const out = join(runDir, 'shell-env');

  await typeCommand(`env > ${shellQuote(out)}`);
  await expect.poll(() => readIf(out), { timeout: 15_000 }).toContain('PATH=');

  const names = readIf(out).split('\n').map((l) => l.split('=')[0]);
  expect({ launchValue: names.includes(BENCH_LAUNCH_ENV), launchFolder: names.includes(APP_LAUNCH_DIR_ENV) }).toEqual({ launchValue: false, launchFolder: false });
});
