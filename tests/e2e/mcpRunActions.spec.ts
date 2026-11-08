import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dump, load } from 'js-yaml';
import { electron, controllerOf } from './registeredElectron';
import { seedFakeAgentV2, seedFakeGhGit, seedIsolatedClaudeConfig, writeCatalogEntry } from './fakeTools';
import { readFakeClaudeLog, resultText, seedFakeClaude } from '../helpers/fakeClaudeHarness';
import type { FakeClaudeRecord } from '../helpers/fakeClaude';
import { WINDOW_TIMEOUT_MS } from '../helpers/e2eBudget';

let app: ElectronApplication | undefined;
let page: Page;
const roots: string[] = [];
const temp = (prefix: string): string => { const p = realpathSync(mkdtempSync(join(tmpdir(), prefix))); roots.push(p); return p; };
test.afterEach(async () => { await app?.close(); app = undefined; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function machine() {
  const home = temp('mcp-entry-home-'); const appHome = temp('mcp-entry-app-'); const repo = temp('mcp-entry-repo-');
  const config = seedIsolatedClaudeConfig('mcp-entry-config-'); roots.push(config);
  const { binDir, logFile } = seedFakeGhGit('mcp-entry-bin-'); roots.push(binDir);
  mkdirSync(join(repo, '.git')); mkdirSync(join(repo, '.agent-terminal/loop'), { recursive: true });
  writeFileSync(join(repo, '.git/HEAD'), 'ref: refs/heads/main\n');
  seedFakeAgentV2(binDir, { stepId: 'plan', artifactRel: '.agent-terminal/loop/artifacts/plan.md', work: 'complete', review: 'full' });
  const claude = seedFakeClaude(binDir, { agent: join(binDir, 'fake-agent') });
  return { home, appHome, repo, config, binDir, logFile, claude };
}
type Machine = ReturnType<typeof machine>;

async function type(text: string): Promise<void> {
  await page.locator('.xterm-screen').click(); await page.keyboard.type(text); await page.keyboard.press('Enter');
}
async function launch(m: Machine, env: Record<string, string> = {}): Promise<void> {
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, HOME: m.home, APP_HOME_DIR: m.appHome,
    CLAUDE_CONFIG_DIR: m.config, APP_SHELL: 'bash', APP_SUBMIT_DELAY_MS: '100', PATH: `${m.binDir}:${process.env.PATH}`, FAKE_GHGIT_LOG: m.logFile, ...env } });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(page.locator('.xterm-rows')).not.toHaveText('');
  await page.locator('[data-viewbtn="4"]').click();
  await page.locator('#mcp-install-view').getByRole('button', { name: 'Install the agent-terminal tools for Claude Code' }).click();
  await expect(page.locator('#mcp-install-view [role="status"]')).toContainText(/installed/i);
  await page.locator('[data-viewbtn="1"]').click();
  await type(`cd "${m.repo}"`);
  await expect(page.locator('#flow-strip .flow-control')).toHaveText('Start');
  await type('claude');
  await expect.poll(() => readFakeClaudeLog(m.claude.logFile).some(r => r.event === 'session')).toBe(true);
}

type Call = Extract<FakeClaudeRecord, { event: 'call' | 'call-unsent' | 'call-lost' }>;
async function prompt(m: Machine, text: string): Promise<Call | undefined> {
  const before = readFakeClaudeLog(m.claude.logFile).length;
  await type(text);
  const records = () => readFakeClaudeLog(m.claude.logFile).slice(before);
  let id: string | undefined;
  await expect.poll(() => { const p = records().find(r => r.event === 'prompt' && r.text === text); id = p?.event === 'prompt' ? p.promptId : undefined; return id; }).toBeDefined();
  await expect.poll(() => records().some(r => r.event === 'stop' && r.promptId === id)).toBe(true);
  return records().filter((r): r is Call => ['call', 'call-unsent', 'call-lost'].includes(r.event)).at(-1);
}
async function call(m: Machine, tool: string, args: Record<string, unknown>): Promise<Call | undefined> {
  await prompt(m, 'mcp read_state {}');
  return prompt(m, `mcp ${tool} ${JSON.stringify({ window: '$read_state.window.id', repo: '$read_state.repo.key', ...args })}`);
}
const answer = (r: Call | undefined) => r?.event === 'call' && r.result
  ? { error: r.result.isError ?? false, message: resultText(r.result) }
  : { error: true, message: r?.event === 'call' ? r.error ?? 'no result' : r?.reason ?? 'no call' };
const read = (file: string): string => existsSync(file) ? readFileSync(file, 'utf8') : '';

for (const mode of ['supplied', 'missing', 'invalid', 'resolved'] as const) {
  test(`MCP loop approve entry: ${mode} next-step input is checked before acceptance and saved without a modal`, { tag: '@ownapp' }, async () => {
    const m = machine();
    writeFileSync(join(m.repo, '.agent-terminal/flow.yaml'), 'name: input-entry\nsteps:\n  - id: plan\n    kind: loop\n    loop: plan-loop\n    loop_namespace: app\n    inputs:\n      - name: pr\n        type: pr\n  - id: next\n    kind: manual\n    inputs:\n      - name: next-ticket\n        type: github-ticket\n');
    writeFileSync(join(m.repo, '.agent-terminal/flow-state.yaml'), `step: plan\nstatus: not_started\ninputs:\n  pr: "321"\n${mode === 'resolved' ? '  next-ticket: "322"\n' : ''}`);
    const defPath = join(m.config, 'loops-v2/plan-loop/plan-loop.yaml');
    const def = load(readFileSync(defPath, 'utf8')) as { pickup?: unknown }; delete def.pickup; writeFileSync(defPath, dump(def));
    await launch(m); await page.locator('#flow-strip .flow-control').click();
    const runFile = join(m.repo, '.agent-terminal/loop/run-state.yaml');
    const stateFile = join(m.repo, '.agent-terminal/flow-state.yaml');
    await expect.poll(() => read(runFile), { timeout: 40_000 }).toContain('verdict: clean');
    const before = { run: read(runFile), state: read(stateFile) };
    const result = answer(await call(m, 'approve', { step: '$read_state.gate.step', turn: '$read_state.gate.turn',
      ...(mode === 'supplied' || mode === 'invalid' ? { inputs: { 'next-ticket': mode === 'supplied' ? '322' : 'not-a-ticket' } } : {}) }));
    if (mode === 'missing' || mode === 'invalid') {
      expect.soft({ error: result.error, reason: /not valid in the current state/i.test(result.message), namesInput: result.message.includes('next-ticket') }).toEqual({ error: true, reason: true, namesInput: true });
      expect.soft(read(m.logFile)).not.toContain('gh pr ready');
      expect.soft({ run: read(runFile), state: read(stateFile) }).toEqual({ run: before.run, state: before.state });
      expect.soft(await page.locator('#flow-strip .stn.active .nm').textContent()).toBe('plan');
    } else {
      expect.soft(result).toMatchObject({ error: false });
      await expect.soft(page.locator('#flow-strip .stn.active .nm')).toHaveText('next');
      const persisted = load(read(stateFile)) as { inputs?: Record<string, string> } | null;
      expect.soft(persisted?.inputs?.['next-ticket']).toBe('322');
      expect.soft(read(m.logFile)).toContain('gh pr ready 321');
    }
    expect.soft(await page.locator('.flow-modal:visible').count()).toBe(0);
  });
}

for (const tool of ['start', 'approve'] as const) {
  test(`MCP ${tool} entry raises the real pickup wipe confirmation and leaves every conflicting resource intact`, { tag: '@ownapp' }, async () => {
    const m = machine();
    writeFileSync(join(m.repo, '.agent-terminal/flow.yaml'), `name: pickup-entry\nsteps:\n${tool === 'approve' ? '  - id: prepare\n    kind: manual\n' : ''}  - id: plan\n    kind: loop\n    loop: plan-loop\n    loop_namespace: app\n    inputs:\n      - name: ticket\n        type: github-ticket\n  - id: done\n    kind: manual\n`);
    const defPath = join(m.config, 'loops-v2/plan-loop/plan-loop.yaml');
    const def = load(readFileSync(defPath, 'utf8')) as Record<string, unknown>;
    def.pickup = { initial_status: 'planning', branch_template: 'plan-loop/issue-{issue}', on_conflict: 'wipe-and-retry' };
    writeFileSync(defPath, dump(def));
    writeFileSync(`${m.logFile}.local-branch`, 'plan-loop/issue-322\n'); writeFileSync(`${m.logFile}.remote-branch`, 'plan-loop/issue-322\n');
    await launch(m, { FAKE_GIT_BRANCH_EXISTS: '1' });
    if (tool === 'approve') { await page.locator('#flow-strip .flow-control').click(); await expect(page.locator('#flow-strip .stn.active .nm')).toHaveText('prepare'); }
    const result = answer(await call(m, tool, { ...(tool === 'approve' ? { step: '$read_state.gate.step' } : {}), inputs: { ticket: '322' } }));
    expect.soft({ error: result.error, namesPickup: /pickup|conflict|confirmation/i.test(result.message), pending: /started|waiting/i.test(result.message) }).toEqual({ error: false, namesPickup: true, pending: true });
    const dialog = page.locator('#flow-confirm-host .flow-modal');
    await expect.soft(dialog).toBeVisible({ timeout: 10_000 });
    await expect.soft(dialog).toContainText('plan-loop/issue-322');
    await expect.soft(dialog).toContainText('#321');
    expect.soft({ local: read(`${m.logFile}.local-branch`), remote: read(`${m.logFile}.remote-branch`), prClosed: existsSync(`${m.logFile}.pr-321-closed`), bootstrapped: read(join(m.repo, '.agent-terminal/loop/bootstrap.yaml')).includes('status: complete') }).toEqual({ local: 'plan-loop/issue-322\n', remote: 'plan-loop/issue-322\n', prClosed: false, bootstrapped: false });
  });
}

for (const tool of ['redo', 'polish', 'retry', 'dismiss_loop_message'] as const) {
  test(`MCP ${tool} reaches the live loop and changes its observable state`, { tag: '@ownapp' }, async () => {
    const m = machine();
    const failed = tool === 'retry' || tool === 'dismiss_loop_message';
    seedFakeAgentV2(m.binDir, { stepId: 'plan', artifactRel: '.agent-terminal/loop/artifacts/plan.md', work: 'complete', review: 'full', logInjected: true,
      ...(failed ? { consolidateAttempts: ['malformed consolidator report\n', 'malformed consolidator report\n'] } : {}) });
    writeFileSync(join(m.repo, '.agent-terminal/flow.yaml'), 'name: actions\nsteps:\n  - id: plan\n    kind: loop\n    loop: plan-loop\n    loop_namespace: app\n  - id: done\n    kind: manual\n');
    const defPath = join(m.config, 'loops-v2/plan-loop/plan-loop.yaml');
    const def = load(read(defPath)) as { pickup?: unknown }; delete def.pickup; writeFileSync(defPath, dump(def));
    await launch(m); await page.locator('#flow-strip .flow-control').click();
    const runFile = join(m.repo, '.agent-terminal/loop/run-state.yaml');
    await expect.poll(() => read(runFile), { timeout: 40_000 }).toContain(failed ? 'status: error' : 'verdict: clean');
    if (failed) await expect.poll(() => controllerOf(app as ElectronApplication).loopMessage()?.kind).toBe('error');
    const result = answer(await call(m, tool, tool === 'dismiss_loop_message'
      ? { message: '$read_state.loopMessage.id' }
      : { step: failed ? '$read_state.stalledTurn.step' : '$read_state.gate.step', turn: failed ? '$read_state.stalledTurn.turn' : '$read_state.gate.turn', ...(tool === 'redo' ? { instruction: 'Rebuild around the distinct retry boundary' } : {}) }));
    expect.soft(result).toMatchObject({ error: false });
    if (tool === 'redo') {
      await expect.soft.poll(() => read(join(m.repo, '.agent-terminal/injected-log')).split('\n').filter(line => !line.startsWith('mcp ')).join('\n'), { timeout: 15_000 }).toContain('Rebuild around the distinct retry boundary');
      await expect.soft.poll(() => read(join(m.repo, '.agent-terminal/work-runs')).length).toBeGreaterThan(1);
    } else if (tool === 'polish') {
      await expect.soft.poll(() => existsSync(join(m.repo, '.agent-terminal/loop/polish.yaml'))).toBe(true);
      await page.locator('#flow-strip .loopstat').click();
      await expect.soft(page.locator('#loop-panel [data-polish-standdown]')).toBeVisible();
    } else if (tool === 'retry') {
      await expect.soft.poll(() => read(runFile), { timeout: 15_000 }).toContain('verdict: clean');
    } else {
      await expect.soft.poll(() => controllerOf(app as ElectronApplication).loopMessage() ?? null).toBeNull();
      const current = answer(await prompt(m, 'mcp read_state {}'));
      expect.soft(JSON.parse(current.message).loopMessage).toBeNull();
    }
    expect.soft(read(join(m.repo, '.agent-terminal/flow-state.yaml'))).toContain('step: plan');
  });
}

test('MCP selects a listed single-loop catalog entry and starts that loop instead of the default flow', { tag: '@ownapp' }, async () => {
  const m = machine();
  writeFileSync(join(m.repo, '.agent-terminal/flow.yaml'), 'name: default-manual\nsteps:\n  - id: default-step\n    kind: manual\n');
  writeCatalogEntry(m.appHome, 'single-loop-choice', 'name: single-loop-choice\nsteps:\n  - id: plan\n    kind: loop\n    loop: plan-loop\n    loop_namespace: app\n');
  const defPath = join(m.config, 'loops-v2/plan-loop/plan-loop.yaml');
  const def = load(read(defPath)) as { pickup?: unknown }; delete def.pickup; writeFileSync(defPath, dump(def));
  await launch(m);
  const listed = JSON.parse(answer(await prompt(m, 'mcp read_state {}')).message) as { startable: { id: string }[] };
  const selected = listed.startable.find(entry => entry.id === 'single-loop-choice');
  expect(selected).toBeDefined();
  expect.soft(answer(await call(m, 'choose_flow', { flow: selected?.id }))).toMatchObject({ error: false });
  await expect.soft(page.locator('#flow-picker').getByRole('button', { name: /flow/i })).toHaveText('Flow: single-loop-choice');
  expect.soft(answer(await call(m, 'start', { inputs: {} }))).toMatchObject({ error: false });
  await expect.soft.poll(() => read(join(m.repo, '.agent-terminal/loop/run-state.yaml')), { timeout: 15_000 }).toContain('verdict: clean');
  await expect.soft(page.locator('#flow-strip .stn.active .nm')).toHaveText('plan');
});

test('MCP approve pickup failure shows its blocking error and rolls back one step in the window and next read', { tag: '@ownapp' }, async () => {
  const m = machine();
  writeFileSync(join(m.repo, '.agent-terminal/flow.yaml'), 'name: failed-pickup\nsteps:\n  - id: prepare\n    kind: manual\n  - id: plan\n    kind: loop\n    loop: plan-loop\n    loop_namespace: app\n    inputs:\n      - name: ticket\n        type: github-ticket\n  - id: done\n    kind: manual\n');
  const defPath = join(m.config, 'loops-v2/plan-loop/plan-loop.yaml');
  const def = load(read(defPath)) as Record<string, unknown>;
  def.pickup = { initial_status: 'planning', branch_template: 'plan-loop/issue-{issue}', on_conflict: 'fail' };
  writeFileSync(defPath, dump(def));
  writeFileSync(`${m.logFile}.local-branch`, 'plan-loop/issue-322\n');
  await launch(m, { FAKE_GIT_BRANCH_EXISTS: '1' });
  await page.locator('#flow-strip .flow-control').click();
  await expect(page.locator('#flow-strip .stn.active .nm')).toHaveText('prepare');
  const result = answer(await call(m, 'approve', { step: '$read_state.gate.step', inputs: { ticket: '322' } }));
  expect.soft({ error: result.error, started: /pickup.*started/i.test(result.message) }).toEqual({ error: false, started: true });
  const dialog = page.locator('#flow-error-host .flow-modal');
  await expect.soft(dialog).toBeVisible();
  await expect.soft(dialog).toContainText('plan-loop/issue-322');
  await expect.soft(page.locator('#flow-strip .stn.active .nm')).toHaveText('prepare');
  const persisted = load(read(join(m.repo, '.agent-terminal/flow-state.yaml'))) as { step?: string; inputs?: Record<string, string> };
  expect.soft(persisted).toMatchObject({ step: 'prepare', inputs: { ticket: '322' } });
  if (await dialog.isVisible()) await dialog.getByRole('button', { name: 'Dismiss' }).click();
  const current = JSON.parse(answer(await prompt(m, 'mcp read_state {}')).message);
  expect.soft(current).toMatchObject({ flow: { step: 'prepare', runStarted: true }, gate: { step: 'prepare', turn: null } });
});
