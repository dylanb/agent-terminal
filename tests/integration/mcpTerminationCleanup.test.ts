import { afterEach, expect, it } from 'vitest';
import { mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createFlowManager } from '../../src/main/flow';
import { createFlowLifecycle } from '../../src/main/flowLifecycle';
import { createTodoStore } from '../../src/main/todoStore';
import { createWorktreeLock } from '../../src/main/worktreeLock';
import { terminatedAnswer } from '../../src/main/mcpFlowOutcome';
import { toolResult } from '../../src/main/mcpTools';
import { createWorktreeFixture } from '../helpers/worktreeFixture';

const fx = createWorktreeFixture();
afterEach(() => fx.cleanup());

it('reports a failed todo cleanup after the run reset and still clears captures', () => {
  const repo = fx.makeWorktree('mcp-cleanup');
  fx.writeFlowHome(repo, { name: 'manual', stepIds: ['prepare', 'finish'] });
  const flow = createFlowManager({ globalDir: fx.outsideDir('cleanup-home') });
  flow.start(repo);
  const todos = createTodoStore({ maxDoneTodos: 10 });
  const before = todos.add(repo, 'persisted work');
  const file = join(repo, '.agent-terminal/todos.json');
  const saved = `${file}.saved`;
  renameSync(file, saved);
  mkdirSync(file);
  const captures = ['report'];
  const lifecycle = createFlowLifecycle({
    flow, lock: createWorktreeLock({ lockRoot: fx.outsideDir('cleanup-locks'), holderLiveness: () => 'live-matching' }),
    recovery: { rebind: () => { throw new Error('unused'); } }, pendingNotices: { post: () => {} }, loopTurnActive: () => false,
    forgetRunEntry: () => {}, endRun: () => {}, recordTerminate: () => {}, releaseLoopTurn: () => {}, clearSliceBrief: () => {}, flowChanged: () => {},
    clearTodos: key => { todos.clear(key); }, clearMonitor: () => { captures.length = 0; }, presentView: (_key, view) => view,
  });
  const result = toolResult({ kind: 'answered', value: terminatedAnswer(lifecycle.terminate(repo)) });
  rmSync(file, { recursive: true });
  renameSync(saved, file);
  expect({ error: result.isError, message: result.content[0].text, status: flow.state(repo).status, captures,
    persisted: createTodoStore({ maxDoneTodos: 10 }).list(repo) }).toEqual({ error: true, message: expect.stringMatching(/terminated.*cleanup.*todos.*(EISDIR|EEXIST|ENOTEMPTY)/is), status: 'not_started', captures: [], persisted: before });
  expect(result.content[0].text).toMatch(/remaining todos|remaining.*captures/i);
});
