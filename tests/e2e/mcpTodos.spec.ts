import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { electron } from './registeredElectron';
import { seedFakeGhGit, seedIsolatedClaudeConfig } from './fakeTools';
import { readFakeClaudeLog, resultText, seedFakeClaude } from '../helpers/fakeClaudeHarness';
import { distinctTodos } from '../helpers/todoFixtures';
import type { McpWindowState } from '../../src/shared/mcpWindowState';
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
  const hold = join(home, 'hold');
  const claude = seedFakeClaude(binDir, { hold });
  writeFileSync(join(repo, '.agent-terminal/flow.yaml'), 'name: todos\nsteps:\n  - id: prepare\n    kind: manual\n  - id: done\n    kind: manual\n');
  writeFileSync(join(repo, '.agent-terminal/todos.json'), JSON.stringify(distinctTodos(repo, ['active', 'active', 'done'])));
  return { home, appHome, repo, config, binDir, logFile, claude, hold };
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


async function current(m: Machine): Promise<McpWindowState> {
  return JSON.parse(answer(await prompt(m, 'mcp read_state {}')).message) as McpWindowState;
}
async function overlay(): Promise<void> {
  await page.getByRole('button', { name: /Quick-send$/ }).click(); await page.getByRole('tab', { name: /^Todo/ }).click();
}
async function shownTodos() {
  return page.locator('.todo[data-todo-id]').evaluateAll(rows => rows.map(row => ({
    id: (row as HTMLElement).dataset.todoId,
    text: row.querySelector('.tx')?.textContent,
    status: row.querySelector('[role="checkbox"]')?.getAttribute('aria-checked'),
  })));
}
for (const tool of ['todo_create', 'todo_edit', 'todo_reorder', 'todo_complete', 'todo_delete'] as const) {
  test(`MCP todos: ${tool} changes the visible overlay from read identities`, { tag: '@ownapp' }, async () => {
    const m = machine(); await launch(m); await overlay();
    const before = await current(m); const [first, second] = before.todos;
    const args = tool === 'todo_create' ? { text: 'a newly captured task' }
      : tool === 'todo_reorder' ? { todos: [second.id, first.id] }
      : { todo: first.id, ...(tool === 'todo_edit' ? { text: 'edited task owned by first row' } : {}) };
    const result = answer(await call(m, tool, args));
    expect.soft(result.error).toBe(false);
    const rows = page.locator('.todo[data-todo-id]');
    if (tool === 'todo_create') await expect.soft(rows.filter({ hasText: 'a newly captured task' })).toHaveCount(1);
    if (tool === 'todo_edit') await expect.soft(page.locator(`[data-todo-id="${first.id}"] .tx`)).toHaveText('edited task owned by first row');
    if (tool === 'todo_complete') await expect.soft(page.locator(`[data-todo-id="${first.id}"]`).getByRole('checkbox')).toHaveAttribute('aria-checked', 'true');
    if (tool === 'todo_delete') await expect.soft(page.locator(`[data-todo-id="${first.id}"]`)).toHaveCount(0);
    if (tool === 'todo_reorder') await expect.soft.poll(async () => (await shownTodos()).filter(t => t.status !== 'true').map(t => t.id)).toEqual([second.id, first.id]);
    await expect.soft(page.locator(`[data-todo-id="${second.id}"] .tx`)).toHaveText(second.text);
  });
}

test('MCP todos: an app-injected turn can edit a todo and pushes preserve the operator draft and focus', { tag: '@ownapp' }, async () => {
  const m = machine(); await launch(m); const state = await current(m); await overlay();
  const draft = page.getByRole('textbox', { name: 'New todo' }); await draft.fill('operator unfinished draft');
  await page.evaluate(text => window.monitor.inject({ text, submit: true }), `mcp todo_edit ${JSON.stringify({ window: state.window.id, repo: state.repo?.key, todo: state.todos[0].id, text: 'edited from an injected turn' })}`);
  await expect.poll(() => readFakeClaudeLog(m.claude.logFile).some(r => (r.event === 'call' || r.event === 'call-unsent') && r.tool === 'todo_edit')).toBe(true);
  await expect.soft(page.locator(`[data-todo-id="${state.todos[0].id}"] .tx`)).toHaveText('edited from an injected turn');
  await expect.soft(draft).toHaveValue('operator unfinished draft'); await expect.soft(draft).toBeFocused();
});

async function beginSend(m: Machine, todo: string): Promise<{ state: McpWindowState; result: ReturnType<typeof answer> }> {
  const state = await current(m); writeFileSync(m.hold, 'hold');
  const before = readFakeClaudeLog(m.claude.logFile).length;
  await type(`mcp todo_send ${JSON.stringify({ window: state.window.id, repo: state.repo?.key, todo })}`);
  const records = () => readFakeClaudeLog(m.claude.logFile).slice(before);
  await expect.poll(() => records().some(r => r.event === 'held')).toBe(true);
  const r = records().find((r): r is Call => ['call', 'call-unsent', 'call-lost'].includes(r.event));
  return { state, result: answer(r) };
}

test('MCP todos: send accepts for after this turn, marks in progress, and delivers the accepted text once after stop', { tag: '@ownapp' }, async () => {
  const m = machine(); const text = 'distinct accepted first line\nsecond line with \x1b[201~ stripped';
  const items = distinctTodos(m.repo, ['active', 'active']); items[0].text = text;
  writeFileSync(join(m.repo, '.agent-terminal/todos.json'), JSON.stringify(items));
  await launch(m); await overlay();
  const sent = await beginSend(m, items[0].id);
  expect.soft({ error: sent.result.error, accepted: /accepted.*delivery.*turn.*ends/i.test(sent.result.message), submitted: /"kind":"submitted"/.test(sent.result.message) }).toEqual({ error: false, accepted: true, submitted: false });
  await expect.soft(page.locator(`[data-todo-id="${items[0].id}"]`).getByRole('checkbox')).toHaveAttribute('aria-checked', 'mixed');
  expect.soft(readFakeClaudeLog(m.claude.logFile).filter(r => r.event === 'prompt' && r.text === text.replace('\x1b[201~', ''))).toEqual([]);
  await page.evaluate(({ repo, id }) => window.monitor.todoUpdate(repo, id, 'edited after acceptance'), { repo: m.repo, id: items[0].id });
  rmSync(m.hold);
  await expect.soft.poll(() => readFakeClaudeLog(m.claude.logFile).filter(r => r.event === 'prompt' && r.text === text.replace('\x1b[201~', '')).length).toBe(1);
  const records = readFakeClaudeLog(m.claude.logFile);
  const acceptedCall = records.find((r): r is Extract<FakeClaudeRecord, { event: 'call' }> => r.event === 'call' && r.tool === 'todo_send');
  const stopped = records.findIndex(r => r.event === 'stop' && r.promptId === acceptedCall?.promptId);
  const delivered = records.findIndex(r => r.event === 'prompt' && r.text === text.replace('\x1b[201~', ''));
  expect.soft({ stopped: stopped >= 0, deliveredAfterStop: delivered > stopped }).toEqual({ stopped: true, deliveredAfterStop: true });
});

test('MCP todos: a second send in the same turn refuses and names the first waiting todo', { tag: '@ownapp' }, async () => {
  const m = machine(); await launch(m); const first = await beginSend(m, 'todo-1');
  const before = readFakeClaudeLog(m.claude.logFile).length;
  await type(`mcp todo_send ${JSON.stringify({ window: first.state.window.id, repo: m.repo, todo: 'todo-2' })}`);
  await expect.poll(() => readFakeClaudeLog(m.claude.logFile).slice(before).some(r => r.event === 'prompt')).toBe(true);
  rmSync(m.hold);
  await expect.poll(() => readFakeClaudeLog(m.claude.logFile).slice(before).some(r => (r.event === 'call' || r.event === 'call-unsent') && r.tool === 'todo_send')).toBe(true);
  const second = readFakeClaudeLog(m.claude.logFile).slice(before).find((r): r is Call => ['call', 'call-unsent', 'call-lost'].includes(r.event));
  expect.soft(first.result.error).toBe(false);
  expect.soft(answer(second)).toMatchObject({ error: true, message: expect.stringMatching(/not valid in the current state/i) });
  expect.soft(['todo-1', 'todo 1 (active)'].some(identity => answer(second).message.includes(identity))).toBe(true);
  await expect.soft.poll(() => readFakeClaudeLog(m.claude.logFile).filter(r => r.event === 'prompt' && r.text === first.state.todos[0].text).length).toBe(1);
  expect.soft(readFakeClaudeLog(m.claude.logFile).filter(r => r.event === 'prompt' && r.text === first.state.todos[1].text)).toEqual([]);
  const after = await current(m);
  expect.soft(after.todos.find(todo => todo.id === first.state.todos[1].id)).toEqual(first.state.todos[1]);
});

for (const injected of [false, true]) {
  test(`MCP todos: capture replaces the prior report and paints findings in a ${injected ? 'non-human' : 'human'} turn`, { tag: '@ownapp' }, async () => {
    const m = machine();
    const agent = join(m.binDir, 'report-agent');
    writeFileSync(agent, 'read -r text\ncase "$text" in\nold-report) printf "\\033[2J\\033[HHere is the summary of findings from this code review:\\n- old finding to replace before merge because it describes a distinct obsolete problem which is no longer relevant to the new report\\n" ;;\nnew-report) printf "\\033[2J\\033[HHere is the summary of findings from this code review:\\n- first new finding worth acting on\\n- second distinct new finding before merge\\n❯ " ;;\nesac\n');
    seedFakeClaude(m.binDir, { agent, hold: m.hold });
    await launch(m, { APP_SHELL_INTEGRATION: '0', APP_LAUNCH_DIR: m.repo });
    await prompt(m, 'old-report'); await overlay(); await page.getByRole('tab', { name: /^Capture/ }).click();
    await page.getByRole('button', { name: 'Capture last report' }).click();
    await expect(page.locator('#monitor-blocks .finding')).toContainText(['old finding to replace before merge']);
    const state = await current(m); await prompt(m, 'new-report');
    const text = `mcp capture_report ${JSON.stringify({ window: state.window.id, repo: state.repo?.key })}`;
    const offset = readFakeClaudeLog(m.claude.logFile).length;
    if (injected) { await page.getByRole('tab', { name: /^Todo/ }).click(); await page.getByRole('textbox', { name: 'New todo' }).fill('draft retained across capture'); }
    if (injected) {
      await page.evaluate(text => window.monitor.inject({ text, submit: true }), text);
      await expect.poll(() => readFakeClaudeLog(m.claude.logFile).slice(offset).some(r => r.event === 'stop')).toBe(true);
    } else await prompt(m, text);
    const record = readFakeClaudeLog(m.claude.logFile).slice(offset).find((r): r is Call => ['call', 'call-unsent', 'call-lost'].includes(r.event));
    const result = answer(record);
    expect.soft(result.error).toBe(false);
    expect.soft(result.message).toContain('first new finding worth acting on');
    expect.soft(result.message).toContain('second distinct new finding before merge');
    if (injected) {
      await expect.soft(page.getByRole('textbox', { name: 'New todo' })).toHaveValue('draft retained across capture');
      await expect.soft(page.getByRole('textbox', { name: 'New todo' })).toBeFocused();
      await page.getByRole('tab', { name: /^Capture/ }).click();
    }
    await expect.soft(page.locator('#monitor-blocks .finding')).toContainText(['first new finding worth acting on', 'second distinct new finding before merge']);
    await expect.soft(page.locator('#monitor-blocks')).not.toContainText('old finding to replace before merge');
  });
}
