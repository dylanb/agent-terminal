import { describe, it, expect } from 'vitest';
import { deriveFlowView } from '../../src/main/flow';
import type { FlowStateView, ScreenWaiting, TodoItem, TodoStatus } from '../../src/shared/ipc';

// §24.2.2 S5 — in-progress status is derived from live signals: agent activity (§8.3) + todo
// completion + gate readiness. Pure function of (flow-state, todos, activity).

const todo = (id: string, status: TodoStatus): TodoItem => ({
  id,
  repoKey: '/r',
  text: id,
  status,
  order: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
});

const ACTIVE: ScreenWaiting = { agentState: 'active', waiting: null };
const QUIET: ScreenWaiting = { agentState: 'quiet', waiting: null };

const inProgress: FlowStateView = { stepName: 's', runStarted: 'never-started' as const, steps: ['s'], stepRuns: ['runs'], decisions: {}, position: 1, total: 1, status: 'in_progress' };

describe('deriveFlowView (§24.2.2 S5 — derived live status)', () => {
  it('augments an in_progress view with activity + n/m done + not-ready', () => {
    const v = deriveFlowView(inProgress, [todo('a', 'done'), todo('b', 'active'), todo('c', 'done')], ACTIVE);
    expect(v.derived).toEqual({ activity: 'active', waiting: null, todosDone: 2, todosTotal: 3, ready: false });
  });

  it('carries the Waiting value beside the screen activity, which keeps its meaning', () => {
    const v = deriveFlowView(inProgress, [todo('a', 'done'), todo('b', 'active')], { agentState: 'quiet', waiting: { program: 'MainThread', others: 1 } });
    expect(v.derived).toEqual({ activity: 'quiet', waiting: { program: 'MainThread', others: 1 }, todosDone: 1, todosTotal: 2, ready: false });
  });

  it('is ready when every todo is done', () => {
    const v = deriveFlowView(inProgress, [todo('a', 'done'), todo('b', 'done')], QUIET);
    expect(v.derived).toEqual({ activity: 'quiet', waiting: null, todosDone: 2, todosTotal: 2, ready: true });
  });

  it('is ready (vacuously) with no todos', () => {
    const v = deriveFlowView(inProgress, [], QUIET);
    expect(v.derived).toEqual({ activity: 'quiet', waiting: null, todosDone: 0, todosTotal: 0, ready: true });
  });

  it('counts in_progress todos as outstanding (not done)', () => {
    const v = deriveFlowView(inProgress, [todo('a', 'in_progress'), todo('b', 'done')], QUIET);
    expect(v.derived).toMatchObject({ todosDone: 1, todosTotal: 2, ready: false });
  });

  it('is pure: same inputs → equal output, and the input view is untouched', () => {
    const todos = [todo('a', 'active')];
    expect(deriveFlowView(inProgress, todos, ACTIVE)).toEqual(deriveFlowView(inProgress, todos, ACTIVE));
    expect(inProgress.derived).toBeUndefined();
  });

  it('passes a non-in_progress view through unchanged (no step is being worked)', () => {
    const notStarted: FlowStateView = { stepName: 's', runStarted: 'never-started' as const, steps: ['s'], stepRuns: ['runs'], decisions: {}, position: 1, total: 1, status: 'not_started' };
    expect(deriveFlowView(notStarted, [todo('a', 'active')], ACTIVE)).toEqual(notStarted);
    const done: FlowStateView = { stepName: 's', runStarted: 'never-started' as const, steps: ['s'], stepRuns: ['runs'], decisions: {}, position: 1, total: 1, status: 'done' };
    expect(deriveFlowView(done, [], QUIET).derived).toBeUndefined();
  });
});
