import { execFileSync } from 'node:child_process';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, readFileSync, readdirSync, renameSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { electron } from './registeredElectron';
import { seedFakeAgentV2, seedFakeGhGit, seedIsolatedClaudeConfig } from './fakeTools';
import { readFakeClaudeLog, resultText, seedFakeClaude } from '../helpers/fakeClaudeHarness';
import { distinctTodos } from '../helpers/todoFixtures';
import type { McpWindowState } from '../../src/shared/mcpWindowState';
import type { FakeClaudeRecord } from '../helpers/fakeClaude';
import { dump, load } from 'js-yaml';
import { windowBridgeDir } from '../../src/main/mcpWindowBridge';
import { parseAuditStream, gateDecisionKind } from '../../src/shared/audit';
import { WINDOW_TIMEOUT_MS } from '../helpers/e2eBudget';

let app: ElectronApplication | undefined;
let page: Page;
const roots: string[] = [];
const suspended = new Set<number>();
const ownedSessions = new Set<number>();
const temp = (prefix: string): string => { const p = realpathSync(mkdtempSync(join(tmpdir(), prefix))); roots.push(p); return p; };
test.afterEach(async () => { await app?.evaluate(() => process.getBuiltinModule('node:test').mock.timers.reset()).catch(() => {}); for (const pid of suspended) { try { process.kill(pid, 'SIGCONT'); } catch {} } suspended.clear(); for (const pid of ownedSessions) { try { process.kill(pid, 'SIGKILL'); } catch {} } ownedSessions.clear(); await app?.close(); app = undefined; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

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
  await page.locator('.xterm-screen').click();
  await page.evaluate(text => window.term.input(`\x1b[200~${text}\x1b[201~\r`), text);
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
  for (const record of readFakeClaudeLog(m.claude.logFile)) if (record.event === 'session') ownedSessions.add(record.pid);
}

type Call = Extract<FakeClaudeRecord, { event: 'call' | 'call-unsent' | 'call-lost' }>;
async function prompt(m: Machine, text: string, injected = false): Promise<Call | undefined> {
  const before = readFakeClaudeLog(m.claude.logFile).length;
  if (injected) await page.evaluate(text => window.monitor.inject({ text, submit: true }), text);
  else await type(text);
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

interface AuditEntry {
  type: string;
  ts: string;
  id?: string;
  text?: string;
  step?: string;
  cmd?: string;
  sendId?: string;
  outcome?: string;
  reason?: string;
  mcp?: { callId: string; tool: string; outcome: string; origin: string; promptId?: string; reason?: string };
}
const auditFiles = (m: Machine): string[] => {
  const dir = join(m.appHome, '.agent-terminal/audit', basename(m.repo));
  return existsSync(dir) ? readdirSync(dir).filter(n => n.endsWith('.yaml')).sort().map(n => join(dir, n)) : [];
};
const auditText = (m: Machine): string => auditFiles(m).map(f => readFileSync(f, 'utf8')).join('');
const entries = (m: Machine): AuditEntry[] => parseAuditStream(auditText(m)).events as AuditEntry[];
const command = (tool: string, args: Record<string, unknown> = {}): string => `mcp ${tool} ${JSON.stringify({ window: '$read_state.window.id', repo: '$read_state.repo.key', ...args })}`;
const calls = (m: Machine, tool?: string) => entries(m).filter(e => e.mcp && (tool === undefined || e.mcp.tool === tool));
const prompts = (m: Machine, text: string) => entries(m).filter(e => e.type === 'mcp.prompt' && e.text === text);
const resultKind = (call: Call | undefined): string => JSON.parse(answer(call).message).kind;

async function start(m: Machine): Promise<void> {
  await page.locator('#flow-strip .flow-control').click();
  await expect.poll(() => auditFiles(m).length).toBe(1);
  await current(m);
}

function expectCall(m: Machine, tool: string, outcome: string, origin = 'human', text?: string, from = 0): AuditEntry | undefined {
  const found = entries(m).slice(from).filter(e => e.mcp?.tool === tool);
  expect.soft(found).toHaveLength(1);
  expect.soft(found[0]?.mcp).toMatchObject({ tool, outcome, origin, callId: expect.any(String) });
  if (text !== undefined) {
    const recorded = prompts(m, text);
    expect.soft(recorded).toHaveLength(1);
    expect.soft(recorded[0]?.id).toEqual(expect.any(String));
    expect.soft(found[0]?.mcp?.promptId).toEqual(recorded[0]?.id ?? 'missing-prompt');
  } else if (origin !== 'human') expect.soft(found[0]?.mcp?.promptId).toBeUndefined();
  return found[0];
}

test('MCP audit: every human prompt is appended in full with its submission time, even without tool calls', { tag: '@ownapp' }, async () => {
  const m = machine(); await launch(m); await start(m);
  const before = auditText(m);
  const text = `first line: preserve punctuation and Unicode λ\n${'long prompt body '.repeat(160)}\nlast distinct line`;
  const began = Date.now(); await prompt(m, text); const ended = Date.now();
  const found = prompts(m, text);
  expect.soft(found).toHaveLength(1);
  expect.soft(found[0]?.id).toEqual(expect.any(String));
  const submitted = Date.parse(found[0]?.ts ?? 'missing');
  expect.soft(submitted >= Math.floor(began / 1000) * 1000 && submitted <= ended).toBe(true);
  expect.soft(calls(m).filter(e => e.mcp?.promptId === found[0]?.id)).toEqual([]);
  expect.soft(auditText(m).startsWith(before)).toBe(true);
});

test('MCP audit: calls in one human prompt retain order, outcomes, reasons and one shared prompt reference', { tag: '@ownapp' }, async () => {
  const m = machine(); await launch(m); await start(m);
  const before = entries(m).length;
  const text = ['mcp read_state {}', command('todo_create', { text: 'human-created item' }), command('todo_edit', { todo: 'absent', text: 'refused edit' }), command('start')].join('\n');
  await prompt(m, text);
  const recorded = prompts(m, text);
  const events = entries(m).slice(before);
  const made = events.filter(e => e.mcp);
  expect.soft(recorded).toHaveLength(1);
  expect.soft(recorded[0]?.id).toEqual(expect.any(String));
  expect.soft(made.map(e => [e.mcp?.tool, e.mcp?.outcome])).toEqual([['read_state', 'success'], ['todo_create', 'created'], ['todo_edit', 'not-valid'], ['start', 'not-valid']]);
  expect.soft(made.every(e => e.mcp?.origin === 'human' && e.mcp.promptId === recorded[0]?.id)).toBe(true);
  expect.soft(new Set(made.map(e => e.mcp?.callId)).size).toBe(4);
  expect.soft(events.findIndex(e => e.type === 'mcp.prompt')).toBe(0);
  expect.soft(made.filter(e => e.mcp?.outcome === 'not-valid').map(e => e.mcp?.reason)).toEqual([expect.stringMatching(/todo no longer exists/i), expect.stringMatching(/cannot start/i)]);
  expect.soft(events.filter(e => e.type === 'todo.created' && e.text === 'human-created item')).toHaveLength(1);
  expect.soft(made.find(e => e.mcp?.tool === 'todo_create')?.type).toBe('todo.created');
});

for (const origin of ['not-human', 'undetermined'] as const) {
  test(`MCP audit: guarded ${origin} refusals are recorded distinctly while reads and refused unguarded calls are omitted`, { tag: '@ownapp' }, async () => {
    const m = machine(); await launch(m); await start(m);
    const offset = entries(m).length;
    const text = ['mcp read_state {}', command('start'), command('todo_edit', { todo: 'absent', text: 'refused' })].join('\n');
    if (origin === 'undetermined') {
      await page.evaluate(() => window.monitor.inject({ text: 'an unsubmitted insert', submit: false }));
      await page.locator('.xterm-screen').click(); await page.keyboard.press('Control+c');
    }
    const result = await prompt(m, text, origin === 'not-human');
    expect(answer(result).error).toBe(true);
    const expected = origin === 'not-human' ? 'not-human-started' : 'origin-undetermined';
    const event = expectCall(m, 'start', expected, origin);
    expect.soft(event?.mcp?.reason ?? '').toMatch(origin === 'not-human' ? /not a human-started turn/i : /turn origin could not be determined/i);
    expect.soft(entries(m).slice(offset).filter(e => e.type === 'mcp.prompt')).toEqual([]);
    expect.soft(entries(m).slice(offset).filter(e => e.mcp).map(e => e.mcp?.tool)).toEqual(['start']);
  });
}

for (const origin of ['human', 'not-human', 'undetermined'] as const) {
  const injected = origin === 'not-human';
  for (const tool of ['todo_create', 'todo_edit', 'todo_complete', 'todo_delete', 'todo_reorder', 'capture_report'] as const) {
    test(`MCP audit: ${tool} records exactly once in a ${origin} turn and never duplicates its existing event`, { tag: '@ownapp' }, async () => {
      const m = machine(); await launch(m); await start(m);
      const state = await current(m);
      const args = tool === 'todo_create' ? { text: 'new audited item' }
        : tool === 'todo_reorder' ? { todos: [state.todos[1].id, state.todos[0].id] }
        : tool === 'capture_report' ? {} : { todo: state.todos[0].id, ...(tool === 'todo_edit' ? { text: 'new audited text' } : {}) };
      const before = entries(m).length;
      const text = command(tool, args);
      if (origin === 'undetermined') {
        await page.evaluate(() => window.monitor.inject({ text: 'pending insert', submit: false }));
        await page.locator('.xterm-screen').click(); await page.keyboard.press('Control+c');
      }
      const result = await prompt(m, text, injected); expect(answer(result).error).toBe(false);
      const event = expectCall(m, tool, resultKind(result), origin, origin === 'human' ? text : undefined);
      const oldKind = ({ todo_create: 'todo.created', todo_edit: 'todo.text', todo_complete: 'todo.status', todo_delete: 'todo.deleted' } as Partial<Record<typeof tool, string>>)[tool];
      if (oldKind) {
        expect.soft(event?.type).toBe(oldKind);
        expect.soft(entries(m).slice(before).filter(e => e.type === oldKind)).toHaveLength(1);
      }
      if (origin !== 'human') expect.soft(prompts(m, text)).toEqual([]);
    });
  }
}

function seedLoop(m: Machine): void {
  seedFakeAgentV2(m.binDir, { stepId: 'plan', artifactRel: '.agent-terminal/loop/artifacts/plan.md', work: 'complete', review: 'full' });
  seedFakeClaude(m.binDir, { agent: join(m.binDir, 'fake-agent') });
  writeFileSync(join(m.repo, '.agent-terminal/flow.yaml'), 'name: audit-gate\nsteps:\n  - id: plan\n    kind: loop\n    loop: plan-loop\n    loop_namespace: app\n  - id: next\n    kind: manual\n  - id: last\n    kind: manual\n');
  const path = join(m.config, 'loops-v2/plan-loop/plan-loop.yaml');
  const def = load(readFileSync(path, 'utf8')) as { pickup?: unknown }; delete def.pickup; writeFileSync(path, dump(def));
}

for (const loop of [false, true]) for (const viaMcp of [false, true]) {
  test(`MCP audit: ${viaMcp ? 'MCP' : 'UI'} ${loop ? 'loop' : 'step'} approval shares its existing decision entry and UI approval has no MCP mark`, { tag: '@ownapp' }, async () => {
    const m = machine();
    if (loop) {
      seedLoop(m);
    } else {
      writeFileSync(join(m.repo, '.agent-terminal/flow.yaml'), 'name: audit-step\nsteps:\n  - id: prepare\n    kind: manual\n  - id: next\n    kind: manual\n  - id: last\n    kind: manual\n');
    }
    await launch(m); await start(m);
    if (loop) await expect.poll(() => readFileSync(join(m.repo, '.agent-terminal/loop/run-state.yaml'), 'utf8'), { timeout: 40_000 }).toContain('verdict: clean');
    await current(m);
    const text = command('approve', { step: '$read_state.gate.step', ...(loop ? { turn: '$read_state.gate.turn' } : {}) });
    let event: AuditEntry | undefined;
    if (viaMcp) {
      const result = await prompt(m, text); expect(answer(result).error).toBe(false);
      event = expectCall(m, 'approve', resultKind(result), 'human', text);
    } else {
      if (loop) {
        await page.locator('#flow-strip .loopstat').click();
        await page.locator('#loop-panel [data-gate-option="approve"]').click();
      }
      else await page.locator('#flow-strip .flow-control').click();
    }
    await expect(page.locator('#flow-strip .stn.active .nm')).toHaveText('next');
    const matching = entries(m).filter(e => loop ? e.type === 'command' && gateDecisionKind(e.cmd ?? '')?.kind === 'decision' : e.type === 'step.entered' && e.step === 'next');
    expect.soft(matching).toHaveLength(1);
    if (viaMcp) expect.soft(event).toEqual(matching[0] ?? 'missing decision');
    else { expect.soft(matching[0]?.mcp).toBeUndefined(); expect.soft(calls(m, 'approve')).toEqual([]); }
    const offset = entries(m).length;
    await page.locator('#flow-strip .flow-control').click();
    await expect(page.locator('#flow-strip .stn.active .nm')).toHaveText('last');
    const ui = entries(m).slice(offset).filter(e => e.type === 'step.entered' && e.step === 'last');
    expect.soft(ui).toHaveLength(1); expect.soft(ui[0]?.mcp).toBeUndefined();
  });
}

test('MCP audit: start opens with its original prompt, done stays open, and terminate records before finalization with no later writes', { tag: '@ownapp' }, async () => {
  const m = machine(); await launch(m); await current(m);
  await prompt(m, 'not recorded outside a run');
  await prompt(m, command('todo_create', { text: 'outside run' }));
  expect.soft(auditFiles(m)).toEqual([]);
  const text = [command('start'), command('todo_create', { text: 'inside run after start' })].join('\n');
  const began = Date.now(); const result = await prompt(m, text); const ended = Date.now(); expect(answer(result).error).toBe(false);
  const event = expectCall(m, 'start', 'started', 'human', text);
  expect.soft(entries(m)[0]).toMatchObject({ type: 'mcp.prompt', text });
  expect.soft(event?.type).toBe('flow.started');
  expect.soft(entries(m).filter(e => e.type === 'flow.started')).toHaveLength(1);
  const submitted = Date.parse(prompts(m, text)[0]?.ts ?? 'missing');
  expect.soft(submitted >= Math.floor(began / 1000) * 1000 && submitted <= ended).toBe(true);
  const created = calls(m, 'todo_create');
  expect.soft(created).toHaveLength(1);
  expect.soft(created[0]?.mcp?.promptId).toEqual(prompts(m, text)[0]?.id ?? 'missing prompt');
  await page.locator('#flow-strip .flow-control').click();
  await page.locator('#flow-strip .flow-control').click();
  const doneText = 'still recorded in a completed run'; await prompt(m, doneText);
  expect.soft(prompts(m, doneText)).toHaveLength(1);
  const state = await current(m);
  const terminating = [command('terminate', { expectedTodoCount: state.terminateTodoCount }), 'mcp read_state {}', command('todo_create', { text: 'same-turn after termination' })].join('\n');
  const logOffset = readFakeClaudeLog(m.claude.logFile).length;
  await prompt(m, terminating);
  const terminated = readFakeClaudeLog(m.claude.logFile).slice(logOffset).find((r): r is Extract<FakeClaudeRecord, { event: 'call' }> => r.event === 'call' && r.tool === 'terminate');
  expect(answer(terminated).error).toBe(false);
  expectCall(m, 'terminate', resultKind(terminated), 'human', terminating);
  const all = entries(m); const final = all.findIndex(e => e.type === 'flow.terminated');
  const callIndex = all.findIndex(e => e.mcp?.tool === 'terminate');
  expect.soft(callIndex >= 0 && callIndex < final).toBe(true);
  expect.soft(all.slice(final + 1)).toEqual([]);
  const frozen = auditText(m);
  await prompt(m, 'after finalization'); await prompt(m, command('todo_create', { text: 'after finalization todo' })); await current(m);
  expect.soft(auditText(m)).toBe(frozen);
});

for (const interruption of ['none', 'clear', 'session exit', 'process exit', 'foreground loss', 'new prompt', 'app injection', 'terminal close'] as const) {
  const drop = interruption !== 'none';
  test(`MCP audit: accepted send ${interruption} has its own entry referencing the send, not another call or human prompt`, { tag: '@ownapp' }, async () => {
    const m = machine(); await launch(m, drop ? { APP_QUIET_MS: '1000000' } : {}); await start(m); const state = await current(m);
    writeFileSync(m.hold, 'held');
    const text = command('todo_send', { todo: state.todos[0].id });
    const offset = readFakeClaudeLog(m.claude.logFile).length;
    await type(text);
    await expect.poll(() => readFakeClaudeLog(m.claude.logFile).slice(offset).some(r => r.event === 'held')).toBe(true);
    const sent = readFakeClaudeLog(m.claude.logFile).slice(offset).find((r): r is Extract<FakeClaudeRecord, { event: 'call' }> => r.event === 'call' && r.tool === 'todo_send');
    expect(answer(sent).error).toBe(false);
    if (drop) {
      await app!.evaluate(() => process.getBuiltinModule('node:test').mock.timers.enable({ apis: ['setTimeout'] }));
      rmSync(m.hold);
      await expect.poll(() => readFakeClaudeLog(m.claude.logFile).slice(offset).some(r => r.event === 'stop' && r.promptId === sent?.promptId)).toBe(true);
      if (interruption === 'terminal close') {
        await app!.evaluate(() => process.getBuiltinModule('node:test').mock.timers.reset());
        await app!.close(); app = undefined;
      } else if (interruption === 'clear' || interruption === 'session exit') {
        await type(interruption === 'clear' ? '/clear' : '/exit');
        await expect.poll(() => readFakeClaudeLog(m.claude.logFile).slice(offset).some(r => r.event === 'session-end')).toBe(true);
      } else if (interruption === 'process exit' || interruption === 'foreground loss') {
        const session = readFakeClaudeLog(m.claude.logFile).find(r => r.event === 'session');
        if (!session) throw new Error('fixture did not start a session');
        if (interruption === 'process exit') process.kill(session.pid, 'SIGKILL');
        else { suspended.add(session.pid); process.kill(session.pid, 'SIGSTOP'); }
        const barrier = join(m.home, 'shell-barrier');
        await type(`printf ready > '${barrier}'`);
        await expect.poll(() => existsSync(barrier)).toBe(true);
        if (interruption === 'foreground loss') {
          await type('bg');
          await expect.poll(() => {
            const [state, group, foreground] = execFileSync('ps', ['-o', 'stat=,pgid=,tpgid=', '-p', String(session.pid)], { encoding: 'utf8' }).trim().split(/\s+/);
            return !state.startsWith('T') && group !== foreground;
          }).toBe(true);
        }
      } else if (interruption === 'app injection') {
        const injected = 'injection before idle delivery';
        await page.evaluate(text => window.monitor.inject({ text, submit: true }), injected);
        await app!.evaluate(() => process.getBuiltinModule('node:test').mock.timers.tick(1000));
        await expect.poll(() => {
          const records = readFakeClaudeLog(m.claude.logFile);
          const p = records.find(r => r.event === 'prompt' && r.text === injected);
          return p && 'promptId' in p && records.some(r => r.event === 'stop' && r.promptId === p.promptId);
        }).toBe(true);
      } else await prompt(m, 'new turn before idle delivery');
      if (app) {
        await app.evaluate(() => process.getBuiltinModule('node:test').mock.timers.tick(1000000));
        await app.evaluate(() => process.getBuiltinModule('node:test').mock.timers.reset());
      }
    } else {
      rmSync(m.hold);
      await expect.poll(() => readFakeClaudeLog(m.claude.logFile).some(r => r.event === 'prompt' && r.text === state.todos[0].text)).toBe(true);
    }
    const accepted = expectCall(m, 'todo_send', 'accepted', 'human', text);
    expect.soft(accepted?.type).toBe('todo.status');
    const deliveries = entries(m).filter(e => e.type === 'mcp.delivery');
    expect.soft(deliveries).toHaveLength(1);
    expect.soft(deliveries[0]).toMatchObject({ outcome: drop ? 'dropped' : 'submitted', sendId: accepted?.mcp?.callId ?? 'missing send' });
    if (drop) expect.soft(deliveries[0]?.reason).toEqual(expect.any(String));
    expect.soft(deliveries[0]?.mcp).toBeUndefined();
    expect.soft(prompts(m, state.todos[0].text)).toEqual([]);
  });
}

test('MCP audit: a failed append never changes a tool outcome or prevents the visible action', { tag: '@ownapp' }, async () => {
  const m = machine(); await launch(m); await start(m);
  const control = await prompt(m, command('todo_create', { text: 'working audit control' }));
  expect(answer(control).error).toBe(false);
  const { todos: controlTodos, ...controlEnvelope } = JSON.parse(answer(control).message);
  expect(controlTodos).toHaveLength(4);
  const offset = entries(m).length;
  const file = auditFiles(m)[0]; const saved = `${file}.saved`;
  renameSync(file, saved); mkdirSync(file);
  const text = command('todo_create', { text: 'survives audit failure' });
  const result = await prompt(m, text); expect.soft(answer(result).error).toBe(false);
  const state = await current(m); expect.soft(state.todos.filter(t => t.text === 'survives audit failure')).toHaveLength(1);
  const { todos: returnedTodos, ...failedEnvelope } = JSON.parse(answer(result).message);
  expect.soft(failedEnvelope).toEqual(controlEnvelope);
  expect.soft(failedEnvelope.kind).toBe('created');
  expect.soft(returnedTodos).toEqual(JSON.parse(readFileSync(join(m.repo, '.agent-terminal/todos.json'), 'utf8')).sort((a: { order: number }, b: { order: number }) => a.order - b.order));
  rmSync(file, { recursive: true }); renameSync(saved, file);
  const after = command('todo_create', { text: 'records after recovery' });
  const recovered = await prompt(m, after); expect(answer(recovered).error).toBe(false);
  expectCall(m, 'todo_create', 'created', 'human', after, offset);
});

test('MCP audit: every remaining guarded tool records its human-call refusal and exact returned outcome', { tag: '@ownapp' }, async () => {
  const m = machine(); await launch(m); await start(m);
  const tools = [
    ['request_changes', { step: 'prepare', turn: 'stale', feedback: 'rework this' }],
    ['redo', { step: 'prepare', turn: 'stale', instruction: 'redo this' }],
    ['polish', { step: 'prepare', turn: 'stale' }],
    ['retry', { step: 'prepare', turn: 'stale' }],
    ['dismiss_loop_message', { message: 'stale-message' }],
    ['choose_flow', { flow: 'unavailable-flow' }],
  ] as const;
  for (const [tool, args] of tools) {
    const text = command(tool, args);
    const result = await prompt(m, text); expect(answer(result).error).toBe(true);
    const entry = expectCall(m, tool, resultKind(result), 'human', text);
    expect.soft(entry?.mcp?.reason).toBe(JSON.parse(answer(result).message).message);
  }
});

test('MCP audit: app-unreachable records nothing, while the recovered same-session call is recorded', { tag: '@ownapp' }, async () => {
  const m = machine(); await launch(m); await start(m);
  const [endpoint] = readdirSync(windowBridgeDir(m.appHome)).map(name => join(windowBridgeDir(m.appHome), name));
  const moved = `${endpoint}.held`;
  const before = auditText(m);
  renameSync(endpoint, moved);
  try {
    const result = await prompt(m, command('todo_create', { text: 'cannot reach app' }));
    expect(answer(result).message).toMatch(/app unreachable/i);
    expect.soft(auditText(m)).toBe(before);
  } finally { renameSync(moved, endpoint); }
  const text = command('todo_create', { text: 'reachable again' });
  const result = await prompt(m, text); expect(answer(result).error).toBe(false);
  expectCall(m, 'todo_create', 'created', 'human', text);
});

test('MCP audit: a run opened later in an existing human turn uses the original prompt text and submission time', { tag: '@ownapp' }, async () => {
  const m = machine(); await launch(m); await current(m);
  writeFileSync(m.hold, 'held');
  const initial = 'the original human request before any run exists';
  const offset = readFakeClaudeLog(m.claude.logFile).length;
  const began = Date.now(); await type(initial);
  await expect.poll(() => readFakeClaudeLog(m.claude.logFile).slice(offset).some(r => r.event === 'held')).toBe(true);
  const ended = Date.now();
  expect.soft(auditFiles(m)).toEqual([]);
  await app!.evaluate((_electron, future) => process.getBuiltinModule('node:test').mock.timers.enable({ apis: ['Date'], now: future }), ended + 3600000);
  const startText = command('start'); await type(startText);
  await expect.poll(() => readFakeClaudeLog(m.claude.logFile).slice(offset).some(r => r.event === 'prompt' && r.text === startText)).toBe(true);
  rmSync(m.hold);
  await expect.poll(() => readFakeClaudeLog(m.claude.logFile).slice(offset).some(r => r.event === 'stop')).toBe(true);
  const started = readFakeClaudeLog(m.claude.logFile).slice(offset).find((r): r is Extract<FakeClaudeRecord, { event: 'call' }> => r.event === 'call' && r.tool === 'start');
  expect(answer(started).error).toBe(false);
  await app!.evaluate(() => process.getBuiltinModule('node:test').mock.timers.reset());
  expectCall(m, 'start', 'started', 'human', initial);
  const recorded = prompts(m, initial)[0];
  const submitted = Date.parse(recorded?.ts ?? 'missing');
  expect.soft(submitted >= Math.floor(began / 1000) * 1000 && submitted <= ended).toBe(true);
  expect.soft(prompts(m, startText)).toEqual([]);
});

test('MCP audit: adding a call to a held human turn appends without rewriting its prompt or earlier call', { tag: '@ownapp' }, async () => {
  const m = machine(); await launch(m); await start(m);
  writeFileSync(m.hold, 'held');
  const offset = entries(m).length;
  const logOffset = readFakeClaudeLog(m.claude.logFile).length;
  const initial = 'keep this original prompt immutable before its first tool call';
  await type(initial);
  await expect.poll(() => readFakeClaudeLog(m.claude.logFile).slice(logOffset).some(r => r.event === 'held')).toBe(true);
  await expect.soft.poll(() => prompts(m, initial)).toHaveLength(1);
  const snapshot = auditText(m);
  const later = ['mcp read_state {}', command('todo_create', { text: 'second call in held turn' })].join('\n');
  await type(later);
  await expect.poll(() => readFakeClaudeLog(m.claude.logFile).slice(logOffset).some(r => r.event === 'prompt' && r.text === later)).toBe(true);
  rmSync(m.hold);
  await expect.poll(() => readFakeClaudeLog(m.claude.logFile).slice(logOffset).some(r => r.event === 'stop')).toBe(true);
  expect.soft(auditText(m).startsWith(snapshot)).toBe(true);
  const recorded = prompts(m, initial);
  expect.soft(recorded).toHaveLength(1);
  const made = entries(m).slice(offset).filter(e => e.mcp);
  expect.soft(made.map(e => e.mcp?.tool)).toEqual(['read_state', 'todo_create']);
  expect.soft(made.map(e => e.mcp?.promptId)).toEqual([recorded[0]?.id ?? 'missing prompt', recorded[0]?.id ?? 'missing prompt']);
  expect.soft(prompts(m, later)).toEqual([]);
});

test('MCP audit: identical human prompts remain distinct occurrences with their own call references', { tag: '@ownapp' }, async () => {
  const m = machine(); await launch(m); await start(m);
  const offset = entries(m).length;
  const text = command('todo_create', { text: 'repeat the same request' });
  expect(answer(await prompt(m, text)).error).toBe(false);
  expect(answer(await prompt(m, text)).error).toBe(false);
  const recorded = prompts(m, text);
  const made = entries(m).slice(offset).filter(e => e.mcp);
  expect.soft(recorded).toHaveLength(2);
  expect.soft(recorded.map(e => e.id)).toEqual([expect.any(String), expect.any(String)]);
  expect.soft(new Set(recorded.map(e => e.id)).size).toBe(2);
  expect.soft(made.map(e => e.mcp?.tool)).toEqual(['todo_create', 'todo_create']);
  expect.soft(made.map(e => e.mcp?.promptId)).toEqual([recorded[0]?.id ?? 'missing first prompt', recorded[1]?.id ?? 'missing second prompt']);
  expect.soft(new Set(made.map(e => e.mcp?.callId)).size).toBe(2);
});

for (const tool of ['request_changes', 'redo', 'polish'] as const) {
  test(`MCP audit: a successful ${tool} annotates exactly its existing decision entry`, { tag: '@ownapp' }, async () => {
    const m = machine(); seedLoop(m); await launch(m); await start(m);
    await expect.poll(() => readFileSync(join(m.repo, '.agent-terminal/loop/run-state.yaml'), 'utf8'), { timeout: 40_000 }).toContain('verdict: clean');
    await current(m);
    const text = command(tool, { step: '$read_state.gate.step', turn: '$read_state.gate.turn', ...(tool === 'request_changes' ? { feedback: 'tighten the implementation' } : tool === 'redo' ? { instruction: 'redo with the full inputs' } : {}) });
    const result = await prompt(m, text); expect(answer(result).error).toBe(false);
    const call = expectCall(m, tool, resultKind(result), 'human', text);
    const decisions = entries(m).filter(e => {
      const kind = e.type === 'command' ? gateDecisionKind(e.cmd ?? '') : null;
      return kind?.family === 'gate' && kind.kind === 'decision' && kind.option === tool.replace('_', '-');
    });
    expect.soft(decisions).toHaveLength(1);
    expect.soft(call).toEqual(decisions[0] ?? 'missing decision');
  });
}

test('MCP audit: a failed human approval side effect records the returned neither outcome once and leaves the gate waiting', { tag: '@ownapp' }, async () => {
  const m = machine(); seedLoop(m);
  const flowFile = join(m.repo, '.agent-terminal/flow.yaml');
  const flow = load(readFileSync(flowFile, 'utf8')) as { steps: Record<string, unknown>[] };
  flow.steps[0].gate_authority = 'human'; flow.steps[0].inputs = [{ name: 'pr', type: 'pr' }]; writeFileSync(flowFile, dump(flow));
  writeFileSync(join(m.repo, '.agent-terminal/flow-state.yaml'), 'step: plan\nstatus: not_started\ninputs:\n  pr: "321"\n');
  await launch(m, { FAKE_GH_FAIL_ACTION: 'mark-ready' }); await start(m);
  await expect.poll(() => readFileSync(join(m.repo, '.agent-terminal/loop/run-state.yaml'), 'utf8'), { timeout: 40_000 }).toContain('verdict: clean');
  const state = await current(m);
  const text = command('approve', { step: '$read_state.gate.step', turn: '$read_state.gate.turn' });
  const result = await prompt(m, text);
  expect(answer(result).error).toBe(true); expect(resultKind(result)).toBe('side-effect-failed');
  const call = expectCall(m, 'approve', 'side-effect-failed', 'human', text);
  expect.soft(call?.mcp?.reason).toBe(JSON.parse(answer(result).message).message);
  const after = await current(m); expect.soft(after.gate).toEqual(state.gate);
  await expect.soft(page.locator('#flow-strip .stn.active .nm')).toHaveText('plan');
});
