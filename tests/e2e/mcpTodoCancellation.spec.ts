import { execFileSync } from 'node:child_process';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
const suspended = new Set<number>();
const nestedProcesses = new Set<number>();
const tmuxSockets = new Set<string>();
const temp = (prefix: string): string => { const p = realpathSync(mkdtempSync(join(tmpdir(), prefix))); roots.push(p); return p; };
test.afterEach(async () => { await app?.evaluate(() => process.getBuiltinModule('node:test').mock.timers.reset()).catch(() => {}); for (const pid of suspended) { try { process.kill(pid, 'SIGCONT'); } catch {} } suspended.clear(); for (const pid of nestedProcesses) { try { process.kill(pid, 'SIGKILL'); } catch {} } nestedProcesses.clear(); for (const socket of tmuxSockets) { try { execFileSync('tmux', ['-S', socket, 'kill-server'], { stdio: 'ignore' }); } catch {} } tmuxSockets.clear(); await app?.close(); app = undefined; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

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
async function launch(m: Machine, env: Record<string, string> = {}, command = 'claude'): Promise<void> {
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
  await type(command);
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
const answer = (r: Call | undefined) => r?.event === 'call' && r.result
  ? { error: r.result.isError ?? false, message: resultText(r.result) }
  : { error: true, message: r?.event === 'call' ? r.error ?? 'no result' : r?.reason ?? 'no call' };


async function current(m: Machine): Promise<McpWindowState> {
  return JSON.parse(answer(await prompt(m, 'mcp read_state {}')).message) as McpWindowState;
}
async function overlay(): Promise<void> {
  await page.getByRole('button', { name: /Quick-send$/ }).click(); await page.getByRole('tab', { name: /^Todo/ }).click();
}
async function beginSend(m: Machine, todo: string): Promise<{ state: McpWindowState; result: ReturnType<typeof answer> }> {
  const state = await current(m); writeFileSync(m.hold, 'hold');
  const before = readFakeClaudeLog(m.claude.logFile).length;
  await type(`mcp todo_send ${JSON.stringify({ window: state.window.id, repo: state.repo?.key, todo })}`);
  const records = () => readFakeClaudeLog(m.claude.logFile).slice(before);
  await expect.poll(() => records().some(r => r.event === 'held')).toBe(true);
  const r = records().find((r): r is Call => ['call', 'call-unsent', 'call-lost'].includes(r.event));
  return { state, result: answer(r) };
}

async function freezeTime(): Promise<void> {
  await page.evaluate(() => window.monitor.onUpdate(msg => { (window as typeof window & { testActivity?: string }).testActivity = msg.agentState; }));
  await app!.evaluate(() => {
    process.getBuiltinModule('node:test').mock.timers.enable({ apis: ['setTimeout'] });
  });
}
async function tick(ms: number): Promise<void> {
  await app!.evaluate((_electron, ms) => { process.getBuiltinModule('node:test').mock.timers.tick(ms); }, ms);
}

async function idle(): Promise<void> {
  await expect.poll(async () => {
    await tick(1000000);
    return await page.evaluate(() => (window as typeof window & { testActivity?: string }).testActivity);
  }).toBe('quiet');
  await tick(1000);
}

for (const interruption of ['process exit', 'process suspension', 'loss of foreground'] as const) {
  test(`MCP cancellation: ${interruption} after Stop cannot submit into the bare shell`, { tag: '@ownapp' }, async () => {
    const m = machine();
    const leaked = join(m.home, 'unexpected-delivery');
    const barrier = join(m.home, 'shell-barrier');
    const items = distinctTodos(m.repo, ['active']);
    items[0].text = `printf leaked > '${leaked}'`;
    writeFileSync(join(m.repo, '.agent-terminal/todos.json'), JSON.stringify(items));
    await launch(m, { APP_QUIET_MS: '1000000' });
    await freezeTime();
    const sent = await beginSend(m, items[0].id);
    expect(sent.result.error).toBe(false);
    const accepted = readFakeClaudeLog(m.claude.logFile).find(r => r.event === 'call' && r.tool === 'todo_send')!;
    rmSync(m.hold);
    await expect.poll(() => readFakeClaudeLog(m.claude.logFile).some(r => r.event === 'stop' && r.promptId === ('promptId' in accepted ? accepted.promptId : ''))).toBe(true);
    expect(existsSync(leaked)).toBe(false);
    if (interruption !== 'process exit') suspended.add(accepted.pid);
    process.kill(accepted.pid, interruption === 'process exit' ? 'SIGTERM' : 'SIGSTOP');
    await type(`printf ready > '${barrier}'`);
    await expect.poll(() => existsSync(barrier)).toBe(true);
    const ownership = () => {
      const [state, group, foreground] = execFileSync('ps', ['-o', 'stat=,pgid=,tpgid=', '-p', String(accepted.pid)], { encoding: 'utf8' }).trim().split(/\s+/);
      return { running: !state.startsWith('T'), foreground: group === foreground };
    };
    if (interruption === 'loss of foreground') {
      await type('bg');
      await expect.poll(ownership).toEqual({ running: true, foreground: false });
    }
    await page.evaluate(() => {
      const probe = window as typeof window & { cancellationEcho?: string };
      probe.cancellationEcho = '';
      window.term.onData(data => { probe.cancellationEcho += data; });
    });
    await idle();
    rmSync(barrier);
    await type(`printf checked > '${barrier}'`);
    await expect.poll(() => existsSync(barrier)).toBe(true);
    expect.soft(await page.evaluate(() => (window as typeof window & { cancellationEcho?: string }).cancellationEcho)).not.toContain('leaked');
    expect.soft(existsSync(leaked)).toBe(false);
    if (interruption !== 'process exit') {
      await type('fg');
      await expect.poll(ownership).toEqual({ running: true, foreground: true });
      await idle();
      await prompt(m, 'foreground restored barrier');
      expect(readFakeClaudeLog(m.claude.logFile).filter(r => r.event === 'prompt' && r.text.includes(items[0].text))).toEqual([]);
    }

  });
}

test('MCP cancellation: an app injection proceeds while the sending turn is still open', { tag: '@ownapp' }, async () => {
  const m = machine();
  await launch(m, { APP_QUIET_MS: '1000000' });
  await freezeTime();
  const sent = await beginSend(m, 'todo-1');
  expect(sent.result.error).toBe(false);
  const injected = 'independent app prompt';
  await page.evaluate(text => window.monitor.inject({ text, submit: true }), injected);
  await tick(1000);
  await expect.poll(() => readFakeClaudeLog(m.claude.logFile).some(r => r.event === 'prompt' && r.text === injected)).toBe(true);
  expect(readFakeClaudeLog(m.claude.logFile).some(r => r.event === 'stop' && r.promptId === readFakeClaudeLog(m.claude.logFile).find(c => c.event === 'held')?.promptId)).toBe(false);
  rmSync(m.hold);
  await expect.poll(() => readFakeClaudeLog(m.claude.logFile).some(r => r.event === 'stop' && r.promptId === readFakeClaudeLog(m.claude.logFile).find(c => c.event === 'held')?.promptId)).toBe(true);

});

for (const source of ['typed prompt', 'app injection'] as const) {
  test(`MCP cancellation: a ${source} after Stop prevents later stale delivery`, { tag: '@ownapp' }, async () => {
    const m = machine();
    await launch(m, { APP_QUIET_MS: '1000000' }); await freezeTime();
    const sent = await beginSend(m, 'todo-1'); expect(sent.result.error).toBe(false);
    rmSync(m.hold);
    await expect.poll(() => readFakeClaudeLog(m.claude.logFile).some(r => r.event === 'stop' && r.promptId === readFakeClaudeLog(m.claude.logFile).find(c => c.event === 'held')?.promptId)).toBe(true);
    const interruption = 'new turn before pending delivery';
    if (source === 'typed prompt') await prompt(m, interruption);
    else {
      await page.evaluate(text => window.monitor.inject({ text, submit: true }), interruption);
      await tick(1000);
      await expect.poll(() => {
        const records = readFakeClaudeLog(m.claude.logFile);
        const id = records.find(r => r.event === 'prompt' && r.text === interruption);
        return id && 'promptId' in id && records.some(r => r.event === 'stop' && r.promptId === id.promptId);
      }).toBe(true);
    }
    await idle();
    await prompt(m, 'barrier after idle');
    expect(readFakeClaudeLog(m.claude.logFile).filter(r => r.event === 'prompt' && r.text.includes(sent.state.todos[0].text))).toEqual([]);
  });
}

test('MCP cancellation: closing the terminal after acceptance cannot send into a replacement window', { tag: '@ownapp' }, async () => {
  const m = machine();
  await launch(m, { APP_QUIET_MS: '1000000' });
  const sent = await beginSend(m, 'todo-1');
  expect(sent.result.error).toBe(false);
  rmSync(m.hold);
  await expect.poll(() => readFakeClaudeLog(m.claude.logFile).some(r => r.event === 'stop' && r.promptId === readFakeClaudeLog(m.claude.logFile).find(c => c.event === 'held')?.promptId)).toBe(true);
  await app!.close(); app = undefined;
  const offset = readFakeClaudeLog(m.claude.logFile).length;
  await launch(m);
  await prompt(m, 'replacement session barrier');
  expect(readFakeClaudeLog(m.claude.logFile).slice(offset).filter(r => r.event === 'prompt' && r.text.includes(sent.state.todos[0].text))).toEqual([]);
});

test('MCP delivered todo: its guarded start call is refused and the visible run and todos stay unchanged', { tag: '@ownapp' }, async () => {
  const m = machine(); await launch(m);
  const state = await current(m);
  const todoText = `mcp start ${JSON.stringify({ window: state.window.id, repo: m.repo })}`;
  await page.evaluate(({ repo, text }) => window.monitor.todoUpdate(repo, 'todo-1', text), { repo: m.repo, text: todoText });
  await overlay();
  const sent = await beginSend(m, 'todo-1');
  expect(sent.result.error).toBe(false);
  const before = await page.evaluate(repo => window.monitor.todoList(repo), m.repo);
  rmSync(m.hold);
  await expect.poll(() => readFakeClaudeLog(m.claude.logFile).some(r => r.event === 'call' && r.tool === 'start')).toBe(true);
  const guarded = readFakeClaudeLog(m.claude.logFile).find((r): r is Call => r.event === 'call' && r.tool === 'start');
  expect.soft(answer(guarded)).toMatchObject({ error: true, message: expect.stringMatching(/not a human-started turn/i) });
  await expect.soft(page.locator('#flow-strip .flow-control')).toHaveText('Start');
  expect.soft(await page.evaluate(repo => window.monitor.todoList(repo), m.repo)).toEqual(before);
});

test('MCP cancellation control: permitting idle delivers an uninterrupted accepted send', { tag: '@ownapp' }, async () => {
  const m = machine();
  await launch(m, { APP_QUIET_MS: '1000000' }); await freezeTime();
  const sent = await beginSend(m, 'todo-1'); expect(sent.result.error).toBe(false);
  rmSync(m.hold);
  await expect.poll(() => readFakeClaudeLog(m.claude.logFile).some(r => r.event === 'stop' && r.promptId === readFakeClaudeLog(m.claude.logFile).find(c => c.event === 'held')?.promptId)).toBe(true);
  await idle();
  await expect.poll(() => readFakeClaudeLog(m.claude.logFile).filter(r => r.event === 'prompt' && r.text === sent.state.todos[0].text).length).toBe(1);
});

for (const nested of [false, true]) {
  test(`MCP recipient interruption: ${nested ? 'outer nested terminal' : 'caller'} restored before idle cannot revive the send`, { tag: '@ownapp' }, async () => {
    const m = machine();
    await launch(m, { APP_QUIET_MS: '1000000' }, nested ? "script -q -c 'exec claude' /dev/null" : 'claude');
    await freezeTime();
    const sent = await beginSend(m, 'todo-1');
    expect(sent.result.error).toBe(false);
    const accepted = readFakeClaudeLog(m.claude.logFile).find(r => r.event === 'call' && r.tool === 'todo_send')!;
    rmSync(m.hold);
    await expect.poll(() => readFakeClaudeLog(m.claude.logFile).some(r => r.event === 'stop' && r.promptId === ('promptId' in accepted ? accepted.promptId : ''))).toBe(true);
    const stopped = nested ? Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(accepted.pid)], { encoding: 'utf8' }).trim()) : accepted.pid;
    if (nested) { nestedProcesses.add(stopped); nestedProcesses.add(accepted.pid); }
    if (nested) expect(execFileSync('ps', ['-o', 'args=', '-p', String(stopped)], { encoding: 'utf8' })).toContain('script -q');
    suspended.add(stopped);
    process.kill(stopped, 'SIGSTOP');
    const barrier = join(m.home, 'returned-to-shell');
    await type(`printf ready > '${barrier}'`);
    await expect.poll(() => existsSync(barrier)).toBe(true);
    await type('fg');
    await expect.poll(() => {
      const [state, group, foreground] = execFileSync('ps', ['-o', 'stat=,pgid=,tpgid=', '-p', String(stopped)], { encoding: 'utf8' }).trim().split(/\s+/);
      return !state.startsWith('T') && group === foreground;
    }).toBe(true);
    await idle();
    await prompt(m, 'after restoration barrier');
    expect(readFakeClaudeLog(m.claude.logFile).filter(r => r.event === 'prompt' && r.text === sent.state.todos[0].text)).toEqual([]);
  });
}

test('MCP nested control: an uninterrupted nested caller receives its accepted send', { tag: '@ownapp' }, async () => {
  const m = machine();
  await launch(m, { APP_QUIET_MS: '1000000' }, "script -q -c 'exec claude' /dev/null");
  await freezeTime();
  const sent = await beginSend(m, 'todo-1');
  expect(sent.result.error).toBe(false);
  const accepted = readFakeClaudeLog(m.claude.logFile).find(r => r.event === 'call' && r.tool === 'todo_send')!;
  nestedProcesses.add(accepted.pid);
  nestedProcesses.add(Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(accepted.pid)], { encoding: 'utf8' }).trim()));
  rmSync(m.hold);
  await expect.poll(() => readFakeClaudeLog(m.claude.logFile).some(r => r.event === 'stop' && r.promptId === ('promptId' in accepted ? accepted.promptId : ''))).toBe(true);
  await idle();
  await expect.poll(() => readFakeClaudeLog(m.claude.logFile).filter(r => r.event === 'prompt' && r.text === sent.state.todos[0].text).length).toBe(1);
});

for (const switchPane of [false, true]) {
  test(`MCP tmux recipient: ${switchPane ? 'switching panes permanently cancels' : 'an uninterrupted pane receives'} the accepted send`, { tag: '@ownapp' }, async () => {
    const m = machine();
    const socket = join(m.home, 'tmux.sock');
    tmuxSockets.add(socket);
    const leaked = join(m.home, 'unexpected-pane-delivery');
    const barrier = join(m.home, 'pane-barrier');
    const items = distinctTodos(m.repo, ['active']);
    items[0].text = switchPane ? `printf leaked > '${leaked}'` : 'first line\nsecond line \x1b[201~end';
    writeFileSync(join(m.repo, '.agent-terminal/todos.json'), JSON.stringify(items));
    await launch(m, { APP_QUIET_MS: '1000000' }, `tmux -f /dev/null -S '${socket}' new-session -s send 'exec claude'`);
    await freezeTime();
    const sent = await beginSend(m, items[0].id);
    expect(sent.result.error).toBe(false);
    const accepted = readFakeClaudeLog(m.claude.logFile).find(r => r.event === 'call' && r.tool === 'todo_send')!;
    rmSync(m.hold);
    await expect.poll(() => readFakeClaudeLog(m.claude.logFile).some(r => r.event === 'stop' && r.promptId === ('promptId' in accepted ? accepted.promptId : ''))).toBe(true);
    const tmux = (...args: string[]) => execFileSync('tmux', ['-S', socket, ...args], { encoding: 'utf8' });
    if (switchPane) {
      tmux('split-window', '-d', '-t', 'send:0', 'exec bash --noprofile --norc');
      tmux('select-pane', '-t', 'send:0.1');
      await type(`printf ready > '${barrier}'`);
      await expect.poll(() => existsSync(barrier)).toBe(true);
      await page.evaluate(() => {
        const probe = window as typeof window & { cancellationEcho?: string };
        probe.cancellationEcho = '';
        window.term.onData(data => { probe.cancellationEcho += data; });
      });
      await idle();
      rmSync(barrier);
      await type(`printf checked > '${barrier}'`);
      await expect.poll(() => existsSync(barrier)).toBe(true);
      expect.soft(existsSync(leaked)).toBe(false);
      expect.soft(await page.evaluate(() => (window as typeof window & { cancellationEcho?: string }).cancellationEcho)).not.toContain('leaked');
      tmux('select-pane', '-t', 'send:0.0');
      await idle();
      await prompt(m, 'original pane restored barrier');
      expect(readFakeClaudeLog(m.claude.logFile).filter(r => r.event === 'prompt' && r.text === items[0].text)).toEqual([]);
    } else {
      await idle();
      await expect.poll(() => readFakeClaudeLog(m.claude.logFile).filter(r => r.event === 'prompt' && r.text === 'first line\nsecond line end').length).toBe(1);
    }
  });
}

test('MCP tmux recipient: an interactive popup cannot receive the caller pane’s accepted send', { tag: '@ownapp' }, async () => {
  const m = machine();
  const socket = join(m.home, 'tmux.sock');
  tmuxSockets.add(socket);
  const leaked = join(m.home, 'unexpected-popup-delivery');
  const barrier = join(m.home, 'popup-barrier');
  const items = distinctTodos(m.repo, ['active']);
  items[0].text = `printf leaked > '${leaked}'`;
  writeFileSync(join(m.repo, '.agent-terminal/todos.json'), JSON.stringify(items));
  await launch(m, { APP_QUIET_MS: '1000000' }, `tmux -f /dev/null -S '${socket}' new-session -s send 'exec claude'`);
  await freezeTime();
  const sent = await beginSend(m, items[0].id);
  expect(sent.result.error).toBe(false);
  const accepted = readFakeClaudeLog(m.claude.logFile).find(r => r.event === 'call' && r.tool === 'todo_send')!;
  rmSync(m.hold);
  await expect.poll(() => readFakeClaudeLog(m.claude.logFile).some(r => r.event === 'stop' && r.promptId === ('promptId' in accepted ? accepted.promptId : ''))).toBe(true);
  execFileSync('tmux', ['-S', socket, 'bind-key', '-n', 'F12', 'display-popup', '-E', 'exec bash --noprofile --norc']);
  await page.keyboard.press('F12');
  await type(`printf ready > '${barrier}'`);
  await expect.poll(() => existsSync(barrier)).toBe(true);
  await idle();
  await expect.poll(() => readFakeClaudeLog(m.claude.logFile).filter(r => r.event === 'prompt' && r.text === items[0].text).length).toBe(1);
  rmSync(barrier);
  await type(`printf checked > '${barrier}'`);
  await expect.poll(() => existsSync(barrier)).toBe(true);
  expect.soft(existsSync(leaked)).toBe(false);
  execFileSync('tmux', ['-S', socket, 'display-popup', '-C']);
  await idle();
  await prompt(m, 'popup closed barrier');
  expect(readFakeClaudeLog(m.claude.logFile).filter(r => r.event === 'prompt' && r.text === items[0].text)).toHaveLength(1);
});

test('MCP tmux recipient: a command prompt cannot receive the caller pane’s accepted send', { tag: '@ownapp' }, async () => {
  const m = machine();
  const socket = join(m.home, 'tmux.sock');
  tmuxSockets.add(socket);
  const leaked = join(m.home, 'unexpected-command-delivery');
  const items = distinctTodos(m.repo, ['active']);
  items[0].text = `run-shell "printf leaked > '${leaked}'"`;
  writeFileSync(join(m.repo, '.agent-terminal/todos.json'), JSON.stringify(items));
  await launch(m, { APP_QUIET_MS: '1000000' }, `tmux -f /dev/null -S '${socket}' new-session -s send 'exec claude'`);
  await freezeTime();
  const sent = await beginSend(m, items[0].id);
  expect(sent.result.error).toBe(false);
  const accepted = readFakeClaudeLog(m.claude.logFile).find(r => r.event === 'call' && r.tool === 'todo_send')!;
  rmSync(m.hold);
  await expect.poll(() => readFakeClaudeLog(m.claude.logFile).some(r => r.event === 'stop' && r.promptId === ('promptId' in accepted ? accepted.promptId : ''))).toBe(true);
  execFileSync('tmux', ['-S', socket, 'bind-key', '-n', 'F11', 'command-prompt', '-p', 'ROUTE_PROMPT']);
  await page.keyboard.press('F11');
  await expect(page.locator('.xterm-rows')).toContainText('ROUTE_PROMPT');
  await page.evaluate(() => {
    const probe = window as typeof window & { cancellationEcho?: string };
    probe.cancellationEcho = '';
    window.term.onData(data => { probe.cancellationEcho += data; });
  });
  await idle();
  await expect.poll(() => readFakeClaudeLog(m.claude.logFile).filter(r => r.event === 'prompt' && r.text === items[0].text).length).toBe(1);
  expect.soft(existsSync(leaked)).toBe(false);
  expect.soft(await page.evaluate(() => (window as typeof window & { cancellationEcho?: string }).cancellationEcho)).not.toContain('ROUTE_PROMPT run-shell');
  await page.keyboard.press('Control+g');
  await expect(page.locator('.xterm-rows')).not.toContainText('ROUTE_PROMPT');
  await idle();
  await prompt(m, 'command prompt closed barrier');
  expect.soft(existsSync(leaked)).toBe(false);
  expect(readFakeClaudeLog(m.claude.logFile).filter(r => r.event === 'prompt' && r.text === items[0].text)).toHaveLength(1);
});

test('MCP delayed submit: foreground loss after paste cannot submit a shell draft', { tag: '@ownapp' }, async () => {
  const m = machine();
  const leaked = join(m.home, 'unexpected-delayed-submit');
  const barrier = join(m.home, 'delayed-submit-barrier');
  await launch(m, { APP_QUIET_MS: '1000000', APP_SUBMIT_DELAY_MS: '10000000' });
  await freezeTime();
  const sent = await beginSend(m, 'todo-1');
  expect(sent.result.error).toBe(false);
  const accepted = readFakeClaudeLog(m.claude.logFile).find(r => r.event === 'call' && r.tool === 'todo_send')!;
  rmSync(m.hold);
  await expect.poll(() => readFakeClaudeLog(m.claude.logFile).some(r => r.event === 'stop' && r.promptId === ('promptId' in accepted ? accepted.promptId : ''))).toBe(true);
  await idle();
  expect(readFakeClaudeLog(m.claude.logFile).filter(r => r.event === 'prompt' && r.text === sent.state.todos[0].text)).toEqual([]);
  suspended.add(accepted.pid);
  process.kill(accepted.pid, 'SIGSTOP');
  await type(`printf ready > '${barrier}'`);
  await expect.poll(() => existsSync(barrier)).toBe(true);
  await page.keyboard.type(`printf leaked > '${leaked}'`);
  await tick(10000000);
  await page.keyboard.press('Control+u');
  rmSync(barrier);
  await type(`printf checked > '${barrier}'`);
  await expect.poll(() => existsSync(barrier)).toBe(true);
  expect(existsSync(leaked)).toBe(false);
});

test('MCP failed paste: a later identical human prompt remains human-started', { tag: '@ownapp' }, async () => {
  const m = machine();
  const socket = join(m.home, 'tmux.sock');
  tmuxSockets.add(socket);
  const fail = join(m.home, 'fail-paste');
  const attempted = join(m.home, 'paste-attempted');
  const realTmux = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim();
  writeFileSync(join(m.binDir, 'tmux'), `#!/bin/sh
for arg do
  if [ "$arg" = load-buffer ] && [ -e "$MCP_TEST_TMUX_FAIL" ]; then
    printf attempted > "$MCP_TEST_TMUX_ATTEMPTED"
    exit 1
  fi
done
exec "$MCP_TEST_REAL_TMUX" "$@"
`, { mode: 0o700 });
  await launch(m, { APP_QUIET_MS: '1000000', MCP_TEST_TMUX_FAIL: fail, MCP_TEST_TMUX_ATTEMPTED: attempted, MCP_TEST_REAL_TMUX: realTmux }, `tmux -f /dev/null -S '${socket}' new-session -s send 'exec claude'`);
  await freezeTime();
  const state = await current(m);
  const todoText = `mcp start ${JSON.stringify({ window: state.window.id, repo: m.repo })}`;
  await page.evaluate(({ repo, text }) => window.monitor.todoUpdate(repo, 'todo-1', text), { repo: m.repo, text: todoText });
  const sent = await beginSend(m, 'todo-1');
  expect(sent.result.error).toBe(false);
  writeFileSync(fail, 'fail');
  rmSync(m.hold);
  await expect.poll(() => readFakeClaudeLog(m.claude.logFile).some(r => r.event === 'stop' && r.promptId === readFakeClaudeLog(m.claude.logFile).find(c => c.event === 'held')?.promptId)).toBe(true);
  await idle();
  await expect.poll(() => existsSync(attempted)).toBe(true);
  expect(readFakeClaudeLog(m.claude.logFile).filter(r => r.event === 'prompt' && r.text === todoText)).toEqual([]);
  rmSync(fail);
  const result = answer(await prompt(m, todoText));
  expect(result.error, result.message).toBe(false);
});
