import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMcpActions } from '../../src/main/mcpActions';
import { createSessionTurns } from '../../src/main/mcpSessionTurns';
import { createTodoStore } from '../../src/main/todoStore';
import type { McpWindowState } from '../../src/shared/mcpWindowState';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const repo = mkdtempSync(join(tmpdir(), 'mcp-failure-')); roots.push(repo);
  let id = 0; let fail = false;
  const store = createTodoStore({ maxDoneTodos: 10, newId: () => String(++id) });
  store.add(repo, 'first'); store.add(repo, 'completed'); store.add(repo, 'last'); store.setStatus(repo, '2', 'done');
  const turns = createSessionTurns({ launchOf: async () => ({ print: false, launchPrompt: false }) });
  const hook = (event: string) => turns.hook(1, { hook_event_name: event, transcript_path: '/transcript', source: 'startup', prompt_id: 'turn', prompt: 'send' });
  hook('SessionStart'); hook('UserPromptSubmit');
  const state = (): McpWindowState => ({ window: { id: 'own' }, repo: { key: repo }, flow: null, selectionUnusable: false, gate: null, stalledTurn: null, loopMessage: null, roundReport: null, todos: store.list(repo), startable: [], startableError: null, terminateTodoCount: null });
  const actions = createMcpActions({ windowId: 'own', originOf: async () => 'human', readState: async () => state(), readGateState: state,
    gate: { autoGate: { humanDecision: () => () => {} }, pickupHold: () => null, bindingOf: () => null, approve: async () => ({ kind: 'advanced', effectFailures: [] }) },
    todos: { ...store, setStatus: (...args) => { if (fail) throw new Error('disk write failed'); return store.setStatus(...args); } },
    sendTodo: (caller, todo, persist) => turns.acceptSend(caller.session!, todo, persist),
  });
  const call = (tool: string, args: Record<string, unknown>) => actions.call({ tool, args: { window: 'own', repo, ...args } }, { session: 1 });
  return { call, store, repo, hook, turns, fail: (value: boolean) => { fail = value; } };
}

it('reorders outstanding todos while completed rows keep their positions', async () => {
  const f = fixture();
  await f.call('todo_reorder', { todos: ['3', '1'] });
  expect(f.store.list(f.repo).map(item => item.id)).toEqual(['3', '2', '1']);
});

it('a failed status write leaves no pending delivery and allows a retry', async () => {
  const f = fixture(); f.fail(true);
  await expect(f.call('todo_send', { todo: '1' })).rejects.toThrow('disk write failed');
  f.hook('Stop');
  const delivered: string[] = [];
  f.turns.deliverPending(true, text => delivered.push(text));
  expect(delivered).toEqual([]);
  f.hook('UserPromptSubmit'); f.fail(false);
  await expect(f.call('todo_send', { todo: '1' })).resolves.toMatchObject({ kind: 'accepted' });
  f.hook('Stop'); f.turns.deliverPending(true, text => delivered.push(text));
  expect(delivered).toEqual(['first']);
});

it.each([{}, '', '   '])('refuses malformed or blank stored text without changing status or queueing delivery: %j', async text => {
  const f = fixture();
  f.store.list(f.repo)[0].text = text as string;
  const before = structuredClone(f.store.list(f.repo));
  expect(await f.call('todo_send', { todo: '1' })).toMatchObject({ outcome: 'refusal', kind: 'not-valid' });
  f.hook('Stop'); const delivered: string[] = [];
  f.turns.deliverPending(true, text => delivered.push(text));
  expect({ todos: f.store.list(f.repo), delivered }).toEqual({ todos: before, delivered: [] });
});

it.each([['1'], ['1', '1']])('refuses an incomplete or duplicated outstanding order without changing any row: %j', async (...ids) => {
  const f = fixture(); const before = structuredClone(f.store.list(f.repo));
  expect(await f.call('todo_reorder', { todos: ids })).toMatchObject({ outcome: 'refusal', kind: 'not-valid' });
  expect(f.store.list(f.repo)).toEqual(before);
});
