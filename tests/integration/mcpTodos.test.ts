import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMcpActions } from '../../src/main/mcpActions';
import { createMonitorEventStore } from '../../src/main/eventStore';
import { captureLastReport } from '../../src/main/captureLast';
import { createTodoStore } from '../../src/main/todoStore';
import { toolResult } from '../../src/main/mcpTools';
import type { McpWindowState } from '../../src/shared/mcpWindowState';
import type { TurnOrigin } from '../../src/shared/turnOrigin';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const TOOLS = ['todo_create', 'todo_edit', 'todo_reorder', 'todo_complete', 'todo_delete', 'todo_send', 'capture_report'] as const;
function fixture(origin: TurnOrigin = 'human', detected = true) {
  const repo = mkdtempSync(join(tmpdir(), 'mcp-todos-')); roots.push(repo);
  let seq = 0;
  const todos = createTodoStore({ maxDoneTodos: 100, newId: () => `todo-${++seq}` });
  todos.add(repo, 'first distinct task'); todos.add(repo, 'second distinct task'); todos.add(repo, 'finished task');
  todos.setStatus(repo, 'todo-3', 'done');
  const foreignRepo = join(repo, 'foreign-repository');
  createTodoStore({ maxDoneTodos: 100, newId: () => 'foreign-todo' }).add(foreignRepo, 'other window task');
  const foreignTodos = () => todos.list(foreignRepo).map(({ id, text, status }) => ({ id, text, status }));
  const state = (): McpWindowState => ({
    window: { id: 'own' }, repo: { key: repo }, flow: null, selectionUnusable: false,
    gate: null, stalledTurn: null, loopMessage: null, roundReport: null,
    todos: todos.list(repo).map(({ id, text, status }) => ({ id, text, status })), startable: [], startableError: null, terminateTodoCount: null,
  });
  const captures = createMonitorEventStore();
  const emission = (text: string, type: 'report' | 'finding' = 'report') => ({ type, source: 'heuristic' as const, text, parentId: null, truncated: false, range: { start: { x: 0, y: 0 }, end: { x: 40, y: 2 }, baseY: 0, bufferType: 'normal' as const } });
  captureLastReport('own', captures, { captureLast: () => ({ report: emission('old captured report'), findings: [emission('old captured finding', 'finding')] }) });
  const captureReport = () => captureLastReport('own', captures, { captureLast: () => detected ? { report: emission('new distinct captured report'), findings: [emission('first distinct finding', 'finding'), emission('second distinct finding', 'finding')] } : null });
  const deps = {
    windowId: 'own', originOf: async () => origin, readState: async () => state(), readGateState: state,
    gate: { autoGate: { humanDecision: () => () => {} }, pickupHold: () => null, bindingOf: () => null,
      approve: async () => ({ kind: 'advanced' as const, effectFailures: [] }) },
    todos, captureReport,
  };
  const actions = createMcpActions(deps);
  const call = async (tool: string, args: Record<string, unknown>) => {
    try {
      const result = toolResult({ kind: 'answered', value: await actions.call({ tool, args }, { session: 501 }) });
      return { error: result.isError, text: result.content.map(c => c.text).join('\n') };
    } catch (e) { return { error: true, text: String(e) }; }
  };
  const args = (tool: string, id = 'todo-1') => ({ window: 'own', repo,
    ...(tool === 'todo_create' ? { text: 'new task with $literal and "quotes"' } : {}),
    ...(['todo_edit', 'todo_complete', 'todo_delete', 'todo_send'].includes(tool) ? { todo: id } : {}),
    ...(tool === 'todo_edit' ? { text: 'edited first task' } : {}),
    ...(tool === 'todo_reorder' ? { todos: ['todo-2', id] } : {}),
  });
  return { repo, todos, state, call, args, captures, foreignRepo, foreignTodos };
}

for (const tool of TOOLS) {
  it.each(['human', 'not-human', 'undetermined'] as const)(`${tool}: wrong window wins in a %s turn and leaves state intact`, async origin => {
    const f = fixture(origin); const before = { state: f.state(), captures: f.captures.list(), foreignTodos: f.foreignTodos() };
    const result = await f.call(tool, { ...f.args(tool), window: 'other', repo: f.foreignRepo });
    expect({ result, after: { state: f.state(), captures: f.captures.list(), foreignTodos: f.foreignTodos() } }).toEqual({ result: { error: true, text: expect.stringMatching(/not this session.s window/i) }, after: before });
  });
  it(`${tool}: stale repository is refused without changing the current list or loop message`, async () => {
    const f = fixture(); const before = { state: f.state(), captures: f.captures.list(), foreignTodos: f.foreignTodos() };
    const result = await f.call(tool, { ...f.args(tool), repo: f.foreignRepo });
    expect({ result, after: { state: f.state(), captures: f.captures.list(), foreignTodos: f.foreignTodos() } }).toEqual({ result: { error: true, text: expect.stringMatching(/not valid in the current state/i) }, after: before });
  });
}
for (const tool of ['todo_edit', 'todo_reorder', 'todo_complete', 'todo_delete', 'todo_send']) {
  it(`${tool}: a missing todo is refused without changing any existing todo`, async () => {
    const f = fixture(); const before = { state: f.state(), captures: f.captures.list(), foreignTodos: f.foreignTodos() }; const result = await f.call(tool, f.args(tool, 'missing'));
    expect({ result, after: { state: f.state(), captures: f.captures.list(), foreignTodos: f.foreignTodos() } }).toEqual({ result: { error: true, text: expect.stringMatching(/not valid in the current state/i) }, after: before });
  });
}
for (const tool of ['todo_edit', 'todo_reorder', 'todo_send']) {
  it(`${tool}: a completed todo is refused and stays unchanged`, async () => {
    const f = fixture(); const before = { state: f.state(), captures: f.captures.list(), foreignTodos: f.foreignTodos() }; const result = await f.call(tool, f.args(tool, 'todo-3'));
    expect({ result, after: { state: f.state(), captures: f.captures.list(), foreignTodos: f.foreignTodos() } }).toEqual({ result: { error: true, text: expect.stringMatching(/not valid in the current state/i) }, after: before });
  });
}
for (const origin of ['human', 'not-human', 'undetermined'] as const) {
  for (const tool of ['todo_create', 'todo_edit', 'todo_reorder', 'todo_complete', 'todo_delete']) {
    it(`${tool}: uses the read_state identities in a ${origin} turn and changes only its intended task`, async () => {
      const f = fixture(origin);
      const current = JSON.parse((await f.call('read_state', {})).text) as McpWindowState;
      const target = current.todos[0].id;
      const before = current.todos;
      const result = await f.call(tool, { ...f.args(tool, target), window: current.window.id, repo: current.repo?.key });
      const expected = tool === 'todo_create' ? [...before, { id: 'todo-4', text: 'new task with $literal and "quotes"', status: 'active' }]
        : tool === 'todo_edit' ? before.map(t => t.id === target ? { ...t, text: 'edited first task' } : t)
        : tool === 'todo_complete' ? before.map(t => t.id === target ? { ...t, status: 'done' } : t)
        : tool === 'todo_delete' ? before.filter(t => t.id !== target)
        : [before[2], before[1], before[0]];
      expect({ error: result.error, active: f.state().todos.filter(t => t.status !== 'done'), done: f.state().todos.filter(t => t.status === 'done') }).toEqual({ error: false, active: expected.filter(t => t.status !== 'done'), done: expected.filter(t => t.status === 'done') });
    });
  }
}
it.each([
  ['undetermined', /turn origin could not be determined/i],
  ['not-human', /not a human-started turn/i],
] as const)('todo_send: %s origin wins before missing target and stale repository', async (origin, reason) => {
  const f = fixture(origin); const before = { state: f.state(), captures: f.captures.list(), foreignTodos: f.foreignTodos() };
  const result = await f.call('todo_send', { ...f.args('todo_send', 'missing'), repo: f.foreignRepo });
  expect({ result, after: { state: f.state(), captures: f.captures.list(), foreignTodos: f.foreignTodos() } }).toEqual({ result: { error: true, text: expect.stringMatching(reason) }, after: before });
});

for (const origin of ['human', 'not-human', 'undetermined'] as const) {
  it(`capture_report replaces the prior report and returns its distinct findings in a ${origin} turn`, async () => {
    const f = fixture(origin); const result = await f.call('capture_report', f.args('capture_report'));
    expect.soft(result.error).toBe(false);
    expect.soft(result.text).toContain('new distinct captured report');
    expect.soft(result.text).toContain('first distinct finding');
    expect.soft(result.text).toContain('second distinct finding');
    expect(f.captures.list().map(e => e.text)).toEqual(['new distinct captured report', 'first distinct finding', 'second distinct finding']);
  });
}
it('capture_report with nothing detected preserves the prior capture and reports no captured report', async () => {
  const f = fixture('not-human', false); const before = f.captures.list();
  const result = await f.call('capture_report', f.args('capture_report'));
  expect({ error: result.error, captures: f.captures.list() }).toEqual({ error: false, captures: before });
});
