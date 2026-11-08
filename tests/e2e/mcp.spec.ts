import { electron, controllerOf } from './registeredElectron';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { WINDOW_TIMEOUT_MS } from '../helpers/e2eBudget';
import { PLAN_V2_ROSTER, seedFakeAgentV2, seedFakeGhGit, seedIsolatedClaudeConfig, writeCatalogEntry, type FakeWorkMode } from './fakeTools';
import { verdictOutput } from '../helpers/consolidatorOutputs';
import { dump, load } from 'js-yaml';
import { readFakeClaudeLog, runFakeClaude, seedFakeClaude, type SeededFakeClaude } from '../helpers/fakeClaudeHarness';
import type { FakeClaudeRecord, McpCallResult } from '../helpers/fakeClaude';
import { snapshotTree } from '../helpers/treeSnapshot';
import { distinctTodos } from '../helpers/todoFixtures';
import { APP_MCP_ACK_TIMEOUT_ENV, MCP_WINDOW_ENV } from '../../src/shared/mcp';
import { windowBridgeDir } from '../../src/main/mcpWindowBridge';

// The Claude Code integration (#322, slice 1): the operator installs it from Settings, and every Claude Code session
// in the window — typed or engine-driven — lists the agent-terminal tools and reads its own window's state.

const SERVER = 'agent-terminal';
const SLICE_TOOLS = ['read_state'];
const USER_STATE = { numStartups: 3, mcpServers: { mine: { type: 'stdio', command: 'my-server', args: [] } } };
const USER_SETTINGS = { theme: 'dark', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'true' }] }] } };
const APP_ARTIFACT_REL = '.agent-terminal/loop/artifacts/plan.md';

let app: ElectronApplication | undefined;
let page: Page;
const temps: string[] = [];
const outerWindows: (() => Promise<void>)[] = [];

test.afterEach(async () => {
  await app?.close();
  app = undefined;
  for (const close of outerWindows.splice(0)) await close();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}

interface Machine {
  home: string;
  appHome: string;
  config: string;
  repo: string;
  binDir: string;
  ghLog: string;
  claude: SeededFakeClaude;
}

/** A temp home, a separate temp app home, a Claude Code config of the test's own holding the operator's own entries, a repository with a
 *  `.gitignore`, and the fake `claude` first on PATH. */
function machine(opts: { agent?: { work?: FakeWorkMode; verdicts?: string[]; reviews?: ('full' | 'needs-human')[] }; gitignore?: boolean } = {}): Machine {
  const home = temp('agent-term-e2e-mcp-home-');
  const appHome = temp('agent-term-e2e-mcp-app-home-');
  const config = seedIsolatedClaudeConfig('agent-term-e2e-mcp-config-');
  temps.push(config);
  writeFileSync(join(config, '.claude.json'), JSON.stringify(USER_STATE, null, 2));
  writeFileSync(join(config, 'settings.json'), JSON.stringify(USER_SETTINGS, null, 2));
  const repo = temp('agent-term-e2e-mcp-repo-');
  mkdirSync(join(repo, '.git'));
  if (opts.gitignore !== false) writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
  const { binDir, logFile: ghLog } = seedFakeGhGit('agent-term-e2e-mcp-bin-');
  temps.push(binDir);
  if (opts.agent) seedFakeAgentV2(binDir, { stepId: 'plan', artifactRel: APP_ARTIFACT_REL, work: opts.agent.work ?? 'complete', review: 'full', ...(opts.agent.verdicts ? { verdicts: opts.agent.verdicts } : {}), ...(opts.agent.reviews ? { reviews: opts.agent.reviews } : {}) });
  const claude = seedFakeClaude(binDir, opts.agent ? { agent: join(binDir, 'fake-agent') } : {});
  return { home, appHome, config, repo, binDir, ghLog, claude };
}

async function launch(m: Machine, inherited: Record<string, string> = {}, main = 'out/main/index.js'): Promise<void> {
  app = await electron.launch({
    args: [main],
    env: {
      ...process.env,
      APP_SHELL: 'bash',
      HOME: m.home,
      APP_HOME_DIR: m.appHome,
      APP_SUBMIT_DELAY_MS: '100',
      CLAUDE_CONFIG_DIR: m.config,
      PATH: `${m.binDir}:${process.env.PATH}`,
      FAKE_GHGIT_LOG: m.ghLog,
      ...inherited,
    },
  });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(page.locator('.xterm-rows')).not.toHaveText('', { timeout: 15_000 });
}

async function typeCommand(cmd: string): Promise<void> {
  await page.locator('.xterm-screen').click();
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe('TEXTAREA');
  await page.keyboard.type(cmd, { delay: 20 });
  await page.keyboard.press('Enter');
}

const settingsAction = (name: 'Install' | 'Remove') =>
  page.locator('#mcp-install-view').getByRole('button', { name: `${name} the agent-terminal tools ${name === 'Install' ? 'for' : 'from'} Claude Code` });
const settingsStatus = () => page.locator('#mcp-install-view [role="status"]');

async function inSettings(name: 'Install' | 'Remove', announced: RegExp): Promise<void> {
  await page.locator('[data-viewbtn="4"]').click();
  await settingsAction(name).click();
  await expect.soft(settingsStatus()).toContainText(announced);
  await page.locator('[data-viewbtn="1"]').click();
}

/** The sessions the fake ran, in order, each with the records it logged. */
function sessions(m: Machine): FakeClaudeRecord[][] {
  const byPid = new Map<number, FakeClaudeRecord[]>();
  for (const r of readFakeClaudeLog(m.claude.logFile)) {
    if (r.event === 'cli') continue;
    byPid.set(r.pid, [...(byPid.get(r.pid) ?? []), r]);
  }
  return [...byPid.values()].filter((records) => records.some((r) => r.event === 'session'));
}

const ended = (m: Machine): number => sessions(m).filter((s) => s.some((r) => r.event === 'session-end')).length;
const listedTools = (records: FakeClaudeRecord[] | undefined): string[] | undefined =>
  records?.flatMap((r) => (r.event === 'tools' && r.server === SERVER ? [r.tools] : []))[0];
const readCalls = (records: FakeClaudeRecord[] | undefined): Extract<FakeClaudeRecord, { event: 'call' }>[] =>
  (records ?? []).filter((r): r is Extract<FakeClaudeRecord, { event: 'call' }> => r.event === 'call' && r.tool === 'read_state');
const resultState = (result: McpCallResult | undefined): Record<string, unknown> | undefined => {
  if (result?.structuredContent !== undefined) return result.structuredContent as Record<string, unknown>;
  const text = result?.content?.find((c) => c.type === 'text')?.text;
  try {
    return text === undefined ? undefined : (JSON.parse(text) as Record<string, unknown>);
  } catch {
    return undefined;
  }
};
const readJson = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'));

const ourHooks = (records: FakeClaudeRecord[] | undefined): Extract<FakeClaudeRecord, { event: 'hook' }>[] =>
  (records ?? []).filter((r): r is Extract<FakeClaudeRecord, { event: 'hook' }> => r.event === 'hook' && r.command !== 'true');
const configFiles = (m: Machine) => ({ state: readJson(join(m.config, '.claude.json')), settings: readJson(join(m.config, 'settings.json')) });
const configBytes = (m: Machine) => ({ state: readFileSync(join(m.config, '.claude.json'), 'utf8'), settings: readFileSync(join(m.config, 'settings.json'), 'utf8') });
/** The servers Claude Code registered, one entry per successful `claude mcp add-json`. */
const registrations = (m: Machine): number => readFakeClaudeLog(m.claude.logFile).filter((r) => r.event === 'cli' && r.exit === 0 && r.argv[0] === 'mcp' && r.argv[1] === 'add-json').length;

test('installing from Settings gives a Claude Code session in the window the tools, changing only its own configuration entries', { tag: '@ownapp' }, async () => {
  const m = machine();
  const repoBefore = snapshotTree(m.repo);
  await launch(m);
  await typeCommand(`cd "${m.repo}"`);

  await typeCommand('claude -p before-install');
  await expect.poll(() => ended(m)).toBe(1);
  await inSettings('Install', /installed/i);
  await typeCommand('claude -p after-install');
  await expect.poll(() => ended(m)).toBe(2);
  const installed = configFiles(m);
  const { [SERVER]: ours, ...others } = (installed.state as { mcpServers: Record<string, unknown> }).mcpServers;
  expect.soft({
    beforeInstall: listedTools(sessions(m)[0]),
    afterInstall: listedTools(sessions(m)[1]),
    ourServer: ours !== undefined,
    ourLaunchInAppHome: typeof (ours as { command?: unknown } | undefined)?.command === 'string' && !relative(m.appHome, (ours as { command: string }).command).startsWith('..'),
    otherServers: others,
    theme: (installed.settings as { theme?: string }).theme,
    repo: snapshotTree(m.repo),
  }).toEqual({ beforeInstall: undefined, afterInstall: SLICE_TOOLS, ourServer: true, ourLaunchInAppHome: true, otherServers: USER_STATE.mcpServers, theme: USER_SETTINGS.theme, repo: repoBefore });

  const bytesAfterInstall = configBytes(m);
  await app?.close();
  await launch(m);
  await typeCommand(`cd "${m.repo}"`);
  await typeCommand('claude -p after-relaunch');
  await expect.poll(() => ended(m)).toBe(3);
  expect.soft({ relaunched: listedTools(sessions(m)[2]), registrations: registrations(m), files: configBytes(m) }).toEqual({ relaunched: SLICE_TOOLS, registrations: 1, files: bytesAfterInstall });

  await inSettings('Remove', /removed/i);
  expect.soft({ hadServer: ours !== undefined, afterRemove: configFiles(m), repo: snapshotTree(m.repo) }).toEqual({
    hadServer: true,
    afterRemove: { state: USER_STATE, settings: USER_SETTINGS },
    repo: repoBefore,
  });
});

test('outside agent-terminal the installed server lists no tools and its hooks print nothing, and in a repository with no .gitignore none is created', { tag: '@ownapp' }, async () => {
  const m = machine({ gitignore: false });
  const repoBefore = snapshotTree(m.repo);
  await launch(m);
  await inSettings('Install', /installed/i);
  await typeCommand(`cd "${m.repo}"`);
  await typeCommand('claude -p in-the-window');
  await expect.poll(() => ended(m)).toBe(1);
  expect.soft(listedTools(sessions(m)[0])).toEqual(SLICE_TOOLS);

  const outside = { PATH: process.env.PATH, HOME: m.home, CLAUDE_CONFIG_DIR: m.config, FAKE_CLAUDE_LOG: m.claude.logFile };
  const run = await runFakeClaude(m.claude.command, ['-p', 'mcp read_state {}'], { env: outside, cwd: m.repo, signal: AbortSignal.timeout(60_000) });
  const records = sessions(m).at(-1);
  const hooks = ourHooks(records);
  await inSettings('Remove', /removed/i);
  expect.soft({ exit: run.exit, tools: listedTools(records), ourHooksRan: hooks.length > 0, noisyHooks: hooks.filter((h) => h.exit !== 0 || h.stdout !== '' || h.stderr !== ''), reads: readCalls(records), repo: snapshotTree(m.repo) }).toEqual({
    exit: 0,
    tools: [],
    ourHooksRan: true,
    noisyHooks: [],
    reads: [],
    repo: repoBefore,
  });
});

/** Copies the build file by file into writable directories of its own, so the copy can be removed afterwards. It
 *  lives under the gitignored `out/`, a tmpfs under the Podman harness, so an interrupted run leaves no copy in the checkout. */
function copyTree(from: string, to: string, skip: (name: string) => boolean = () => false): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (skip(entry.name)) continue;
    if (entry.isDirectory()) copyTree(join(from, entry.name), join(to, entry.name));
    else copyFileSync(join(from, entry.name), join(to, entry.name));
  }
}

test('a session in the window still gets the tools after the app installed them from another build location, now gone, is started from here', { tag: '@ownapp' }, async () => {
  const m = machine();
  const elsewhere = realpathSync(mkdtempSync(join(process.cwd(), 'out', '.moved-build-')));
  temps.push(elsewhere);
  copyTree('out', join(elsewhere, 'out'), (name) => name.startsWith('.moved-build-'));
  await launch(m, {}, join(elsewhere, 'out', 'main', 'index.js'));
  await inSettings('Install', /installed/i);
  await app?.close();
  app = undefined;
  rmSync(elsewhere, { recursive: true, force: true });

  await launch(m);
  await typeCommand(`cd "${m.repo}"`);
  await typeCommand('claude -p after-the-move');
  await expect.poll(() => ended(m)).toBe(1);
  expect.soft(listedTools(sessions(m)[0])).toEqual(SLICE_TOOLS);
});

test('a session whose window is gone is told the app is unreachable', { tag: '@ownapp' }, async () => {
  const m = machine();
  await launch(m);
  await inSettings('Install', /installed/i);
  await app?.close();
  app = undefined;

  const orphaned = { PATH: process.env.PATH, HOME: m.home, CLAUDE_CONFIG_DIR: m.config, FAKE_CLAUDE_LOG: m.claude.logFile, [MCP_WINDOW_ENV]: join(m.home, 'gone.sock') };
  await runFakeClaude(m.claude.command, ['-p', 'mcp read_state {}'], { env: orphaned, cwd: m.repo, signal: AbortSignal.timeout(60_000) });
  const result = readCalls(sessions(m).at(-1))[0]?.result;
  expect.soft({ isError: result?.isError, text: (result?.content ?? []).map((c) => c.text ?? '').join('\n') }).toEqual({ isError: true, text: expect.stringMatching(/app unreachable/i) });
});

test("a session's server gives up as app unreachable after the APP_MCP_ACK_TIMEOUT_MS its own session sets", { tag: '@ownapp' }, async () => {
  const m = machine();
  await launch(m);
  await inSettings('Install', /installed/i);
  await app?.close();
  app = undefined;

  const silentEndpoint = join(m.home, 'silent-window.sock');
  let connections = 0;
  const held: Socket[] = [];
  const silent: Server = createServer((socket) => {
    connections += 1;
    held.push(socket);
  });
  await new Promise<void>((done) => silent.listen(silentEndpoint, done));
  const stopWaiting = new AbortController();
  outerWindows.push(() => new Promise<void>((done) => { stopWaiting.abort(); held.forEach((s) => s.destroy()); silent.close(() => done()); }));
  const session = (ackTimeout: string) => ({ PATH: process.env.PATH, HOME: m.home, CLAUDE_CONFIG_DIR: m.config, FAKE_CLAUDE_LOG: m.claude.logFile, [MCP_WINDOW_ENV]: silentEndpoint, [APP_MCP_ACK_TIMEOUT_ENV]: ackTimeout });

  let patientEnded = false;
  const patient = runFakeClaude(m.claude.command, ['-p', 'mcp read_state {}'], { env: session('3600000'), cwd: m.repo, signal: stopWaiting.signal })
    .catch(() => undefined)
    .finally(() => { patientEnded = true; });
  await expect.poll(() => connections > 0 || patientEnded).toBe(true);
  await runFakeClaude(m.claude.command, ['-p', 'mcp read_state {}'], { env: session('1'), cwd: m.repo, signal: AbortSignal.timeout(60_000) });
  const impatient = readCalls(sessions(m).at(-1))[0]?.result;
  const patientStillWaiting = !patientEnded;
  stopWaiting.abort();
  await patient;
  expect.soft({ impatient: { isError: impatient?.isError, text: (impatient?.content ?? []).map((c) => c.text ?? '').join('\n') }, patientStillWaiting }).toEqual({
    impatient: { isError: true, text: expect.stringMatching(/app unreachable/i) },
    patientStillWaiting: true,
  });
});

test("a window whose bridge cannot open still runs its terminal, and its sessions get no tools, even with an outer window's endpoint inherited", { tag: '@ownapp' }, async () => {
  const m = machine();
  const blocked = windowBridgeDir(m.appHome);
  mkdirSync(dirname(blocked), { recursive: true });
  writeFileSync(blocked, 'not a directory\n');
  const outerEndpoint = join(m.home, 'outer-window.sock');
  let outerConnections = 0;
  const held: Socket[] = [];
  const outer: Server = createServer((socket) => {
    outerConnections += 1;
    held.push(socket);
  });
  await new Promise<void>((done) => outer.listen(outerEndpoint, done));
  outerWindows.push(() => new Promise<void>((done) => { held.forEach((s) => s.destroy()); outer.close(() => done()); }));
  await launch(m, { [MCP_WINDOW_ENV]: outerEndpoint });
  await inSettings('Install', /installed/i);
  await typeCommand(`cd "${m.repo}"`);
  await typeCommand('echo terminal-still-works');
  await typeCommand('claude -p in-a-broken-window');
  await expect.poll(() => ended(m)).toBe(1);
  const terminalEchoed = await page.locator('.xterm-rows > div').filter({ hasText: /^\s*terminal-still-works\s*$/ }).count();
  expect.soft({ terminalEchoed, tools: listedTools(sessions(m)[0]), outerConnections }).toEqual({ terminalEchoed: 1, tools: [], outerConnections: 0 });
});

test('a failed install from Settings shows its reason and changes no configuration', { tag: '@ownapp' }, async () => {
  const m = machine();
  const settings = join(m.config, 'settings.json');
  writeFileSync(settings, '{ "theme": "dark",');
  const files = () => ({ state: readFileSync(join(m.config, '.claude.json'), 'utf8'), settings: readFileSync(settings, 'utf8') });
  const before = files();
  await launch(m);
  await page.locator('[data-viewbtn="4"]').click();
  await settingsAction('Install').click();
  await expect
    .poll(async () => ({ alert: await page.locator('#mcp-install-view [role="alert"]').textContent(), status: await settingsStatus().textContent(), files: files() }))
    .toEqual({ alert: expect.stringContaining(settings), status: expect.not.stringMatching(/installed/i), files: before });
});

/** A repository whose flow is a §27 plan loop with a human gate and no pull request yet, then a manual step, with its
 *  bootstrap done. */
function seedGateFlow(repo: string): void {
  mkdirSync(join(repo, '.agent-terminal', 'loop'), { recursive: true });
  writeFileSync(
    join(repo, '.agent-terminal', 'flow.yaml'),
    'name: v2-gate\nsteps:\n  - id: plan\n    kind: loop\n    loop: plan-loop\n    loop_namespace: app\n    inputs:\n      - name: ticket\n        type: github-ticket\n      - name: pr\n        type: pr\n  - id: done\n    kind: manual\n',
  );
  writeFileSync(join(repo, '.agent-terminal', 'flow-state.yaml'), 'step: plan\nstatus: not_started\ninputs:\n  ticket: "176"\n');
  writeFileSync(
    join(repo, '.agent-terminal', 'loop', 'bootstrap.yaml'),
    'schema_version: 1\nstatus: complete\npr: 4242\nbranch: plan-loop/issue-176\nissue: 176\ninitial_status: planning\nupdated_at: 2026-07-23T00:00:00.000Z\n',
  );
  writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/plan-loop/issue-176\n');
}

/** The fixture's own plan loop: no pickup, so an approve with no pull request posts its notice, and a work prompt that
 *  makes the engine's turn read the window. */
function ownPlanLoop(config: string): void {
  const dir = join(config, 'loops-v2', 'plan-loop');
  const defPath = join(dir, 'plan-loop.yaml');
  const def = load(readFileSync(defPath, 'utf8')) as { pickup?: unknown; work: { recipe: string } };
  delete def.pickup;
  writeFileSync(defPath, dump(def));
  appendFileSync(join(dir, def.work.recipe), '\nmcp read_state {}\n');
}

const latestReport = (repo: string): unknown => {
  const dir = join(repo, '.agent-terminal', 'loop', 'reports');
  const rounds = existsSync(dir) ? readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)).map((f) => Number(f.slice(0, -5))) : [];
  return rounds.length === 0 ? null : readJson(join(dir, `${Math.max(...rounds)}.json`));
};

type ReadState = {
  repo?: { key?: string } | null;
  flow?: { selected?: string | null; step?: string };
  gate?: { step?: string; turn?: string | null; options?: string[]; engineDeciding?: boolean } | null;
  todos?: { id: string; text: string; status: string }[];
  loopMessage?: unknown;
  roundReport?: unknown;
  startable?: { id: string; name: string }[] | null;
  terminateTodoCount?: number | null;
};

test("an engine-driven session lists the tools, reads its window in the engine's turn, and every read matches the window", { tag: '@ownapp' }, async () => {
  const m = machine({ agent: { reviews: ['needs-human', 'full'], verdicts: [verdictOutput('another round', { roster: [PLAN_V2_ROSTER[0]] }), verdictOutput('clean')] } });
  seedGateFlow(m.repo);
  writeFileSync(join(m.repo, '.agent-terminal', 'todos.json'), JSON.stringify(distinctTodos(m.repo, ['active', 'in_progress', 'done'])));
  ownPlanLoop(m.config);
  writeCatalogEntry(m.appHome, 'picker-entry', 'name: picker-entry\nsteps:\n  - id: only\n    kind: manual\n');
  const runStateFile = join(m.repo, '.agent-terminal', 'loop', 'run-state.yaml');
  await launch(m);
  await inSettings('Install', /installed/i);
  await typeCommand(`cd "${m.repo}"`);
  await expect(page.locator('#flow-strip .flow-control')).toHaveText('Start', { timeout: 10_000 });
  await typeCommand('claude');
  await expect.poll(() => sessions(m).length).toBe(1);
  const session = (): FakeClaudeRecord[] | undefined => sessions(m)[0];
  const stops = (): number => (session() ?? []).filter((r) => r.event === 'stop').length;
  /** A typed `read_state` turn in the window's session, and what it returned. */
  const typedRead = async (): Promise<ReadState | undefined> => {
    const turnsBefore = stops();
    const callsBefore = readCalls(session()).length;
    await typeCommand('mcp read_state {}');
    await expect.poll(stops).toBe(turnsBefore + 1);
    return resultState(readCalls(session())[callsBefore]?.result) as ReadState | undefined;
  };

  const beforeStart = await typedRead();
  const picker = page.locator('#app .rail:has(#flow-strip) #flow-picker');
  await expect(picker.getByRole('button', { name: /flow/i })).toBeEnabled({ timeout: 10_000 });
  await picker.getByRole('button', { name: /flow/i }).click();
  await expect(picker.getByRole('listbox')).toBeVisible();
  const pickerEntries = await picker.getByRole('option').evaluateAll((options) =>
    options.map((o) => ({ id: (o as HTMLElement).dataset.flowKey ?? '', name: o.querySelector('.flow-picker-name')?.textContent ?? '' })),
  );
  const pickerSelected = await picker.locator('[role="option"][aria-selected="true"]').evaluateAll((options) => (options[0] as HTMLElement | undefined)?.dataset.flowKey ?? null);
  await page.keyboard.press('Escape');
  expect.soft(pickerEntries.length).toBeGreaterThan(0);
  expect.soft({ selected: beforeStart?.flow?.selected, startable: beforeStart?.startable, terminateTodoCount: beforeStart?.terminateTodoCount, repo: beforeStart?.repo, gate: beforeStart?.gate }).toEqual({
    selected: pickerSelected,
    startable: pickerEntries,
    terminateTodoCount: null,
    repo: { key: m.repo },
    gate: null,
  });

  const callsBeforeStart = readCalls(session()).length;
  await page.locator('#flow-strip .flow-control').click();
  await expect.poll(() => (existsSync(runStateFile) ? readFileSync(runStateFile, 'utf8') : ''), { timeout: 40_000 }).toContain('verdict: clean');
  await page.locator('#flow-strip .loopstat').click();
  await expect(page.locator('#loop-panel [data-gate-option="approve"]')).toBeVisible({ timeout: 10_000 });

  const engineTurn = readCalls(session())[callsBeforeStart];
  const engineTurnPrompt = (session() ?? []).find((r): r is Extract<FakeClaudeRecord, { event: 'prompt' }> => r.event === 'prompt' && r.promptId === engineTurn?.promptId);
  expect.soft({ tools: listedTools(session()), engineMadeTheCall: engineTurnPrompt?.text.includes('mcp read_state {}') === true && engineTurnPrompt.text !== 'mcp read_state {}', isError: engineTurn?.result?.isError, step: (resultState(engineTurn?.result) as ReadState | undefined)?.flow?.step }).toEqual({
    tools: SLICE_TOOLS,
    engineMadeTheCall: true,
    isError: false,
    step: 'plan',
  });

  const atGate = await typedRead();
  const shownOptions = await page.locator('#loop-panel [data-gate-option]').evaluateAll((els) => els.map((el) => el.getAttribute('data-gate-option') ?? ''));
  const gateTurn = /^turn_key: (\S+)$/m.exec(readFileSync(runStateFile, 'utf8'))?.[1];
  const shownStep = await page.locator('#flow-strip .stn.active .nm').textContent();
  const shownDeciding = (await page.locator('#loop-panel [data-auto-deciding]').count()) > 0;
  const reportsDir = join(m.repo, '.agent-terminal', 'loop', 'reports');
  expect.soft({ secondRound: existsSync(join(reportsDir, '2.json')), roundsDiffer: existsSync(join(reportsDir, '2.json')) && JSON.stringify(readJson(join(reportsDir, '1.json'))) !== JSON.stringify(readJson(join(reportsDir, '2.json'))) }).toEqual({ secondRound: true, roundsDiffer: true });
  await page.locator('#qs').click();
  await page.locator('#tab-todo').click();
  const shownTodos = await page.locator('.todo[data-todo-id]').evaluateAll((rows) =>
    rows.map((row) => {
      const checked = row.querySelector('.chk')?.getAttribute('aria-checked');
      return { id: (row as HTMLElement).dataset.todoId ?? '', text: row.querySelector('.tx')?.textContent ?? '', status: checked === 'true' ? 'done' : checked === 'mixed' ? 'in_progress' : 'active' };
    }),
  );
  await page.locator('#flow-strip .flow-terminate').click();
  const terminate = page.locator('#flow-confirm-host .flow-modal').filter({ hasText: 'Terminate flow' });
  await expect(terminate).toBeVisible();
  const shownCount = Number(/deletes (\d+) todo/.exec((await terminate.textContent()) ?? '')?.[1]);
  await terminate.getByRole('button', { name: 'Cancel' }).click();
  expect.soft(shownTodos).toHaveLength(3);
  expect.soft({
    repo: atGate?.repo,
    selected: atGate?.flow?.selected,
    step: atGate?.flow?.step,
    gate: atGate?.gate && { step: atGate.gate.step, turn: atGate.gate.turn, options: [...(atGate.gate.options ?? [])].sort(), engineDeciding: atGate.gate.engineDeciding },
    todos: atGate?.todos,
    roundReport: atGate?.roundReport,
    loopMessage: atGate?.loopMessage,
    terminateTodoCount: atGate?.terminateTodoCount,
  }).toEqual({
    repo: { key: m.repo },
    selected: pickerSelected,
    step: shownStep,
    gate: { step: 'plan', turn: gateTurn, options: [...shownOptions].sort(), engineDeciding: shownDeciding },
    todos: shownTodos,
    roundReport: latestReport(m.repo),
    loopMessage: controllerOf(app as ElectronApplication).loopMessage() ?? null,
    terminateTodoCount: shownCount,
  });

  await page.locator('#loop-panel [data-gate-option="approve"]').click();
  await expect.poll(() => controllerOf(app as ElectronApplication).loopMessage()?.reason ?? '', { timeout: 15_000 }).toContain('no PR to mark ready');
  await expect(page.locator('#flow-strip .stn.active .nm')).toHaveText('done', { timeout: 10_000 });
  const pastLoop = await typedRead();
  expect.soft({ step: pastLoop?.flow?.step, loopMessage: pastLoop?.loopMessage, roundReport: pastLoop?.roundReport }).toEqual({
    step: 'done',
    loopMessage: controllerOf(app as ElectronApplication).loopMessage(),
    roundReport: null,
  });
});

/** A typed `read_state` turn in the window's one session, and what it returned. */
async function readInSession(m: Machine): Promise<ReadState | undefined> {
  const session = (): FakeClaudeRecord[] | undefined => sessions(m)[0];
  const stops = (): number => (session() ?? []).filter((r) => r.event === 'stop').length;
  const turnsBefore = stops();
  const callsBefore = readCalls(session()).length;
  await typeCommand('mcp read_state {}');
  await expect.poll(stops).toBe(turnsBefore + 1);
  return resultState(readCalls(session())[callsBefore]?.result) as ReadState | undefined;
}

test("a read's loop message is the one the controller card shows, also once a failed turn recovers and the card withdraws its error", { tag: '@ownapp' }, async () => {
  const m = machine({ agent: { work: 'ask' } });
  seedGateFlow(m.repo);
  ownPlanLoop(m.config);
  await launch(m, { APP_TURN_TIMEOUT_MS: '4000' });
  await inSettings('Install', /installed/i);
  await typeCommand(`cd "${m.repo}"`);
  await expect(page.locator('#flow-strip .flow-control')).toHaveText('Start', { timeout: 10_000 });
  await typeCommand('claude');
  await expect.poll(() => sessions(m).length).toBe(1);
  await page.locator('#flow-strip .flow-control').click();
  await expect.poll(() => controllerOf(app as ElectronApplication).loopMessage()?.kind, { timeout: 30_000 }).toBe('error');

  const whileFailed = await readInSession(m);
  const shownWhileFailed = controllerOf(app as ElectronApplication).loopMessage() ?? null;
  await typeCommand('yes');
  await expect.poll(() => controllerOf(app as ElectronApplication).loopMessage() ?? null, { timeout: 40_000 }).toBeNull();
  const recovered = await readInSession(m);
  expect.soft({ whileFailed: whileFailed?.loopMessage, recovered: recovered?.loopMessage }).toEqual({
    whileFailed: shownWhileFailed,
    recovered: controllerOf(app as ElectronApplication).loopMessage() ?? null,
  });
});

test('a read before Start names the flow the picker has selected, among the flows it lists', { tag: '@ownapp' }, async () => {
  const m = machine();
  writeCatalogEntry(m.appHome, 'picker-entry', 'name: picker-entry\nsteps:\n  - id: only\n    kind: manual\n');
  writeCatalogEntry(m.appHome, 'picker-other', 'name: picker-other\nsteps:\n  - id: first\n    kind: manual\n');
  await launch(m);
  await inSettings('Install', /installed/i);
  await typeCommand(`cd "${m.repo}"`);
  const picker = page.locator('#app .rail:has(#flow-strip) #flow-picker');
  const trigger = picker.getByRole('button', { name: /flow/i });
  await expect(trigger).toBeEnabled({ timeout: 10_000 });
  await trigger.click();
  await picker.getByRole('option', { name: /picker-other/ }).click();
  await expect(trigger).toHaveText('Flow: picker-other', { timeout: 10_000 });
  await trigger.click();
  const pickerEntries = await picker.getByRole('option').evaluateAll((options) =>
    options.map((o) => ({ id: (o as HTMLElement).dataset.flowKey ?? '', name: o.querySelector('.flow-picker-name')?.textContent ?? '' })),
  );
  await page.keyboard.press('Escape');

  await typeCommand(`claude -p 'mcp read_state {}'`);
  await expect.poll(() => ended(m)).toBe(1);
  const state = resultState(readCalls(sessions(m)[0])[0]?.result) as ReadState | undefined;
  expect.soft({ selected: state?.flow?.selected, startable: state?.startable }).toEqual({ selected: 'picker-other', startable: pickerEntries });
});
