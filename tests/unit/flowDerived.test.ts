import { describe, it, expect } from 'vitest';
import { ADVANCE_NOT_READY_NOTICE, advanceWithReadinessGate, deriveFlowView } from '../../src/main/flow';
import type { FlowStateView, TodoItem, TodoStatus } from '../../src/shared/ipc';

// §24.2.2 S5 — the in-progress status is DERIVED from live signals: agent activity (§8.3) + todo
// completion (n/m done) + gate readiness (every todo done). It must be a PURE function of its
// three inputs (flow-state, todos, activity), so the same inputs always yield the same view and
// nothing is mutated. Tests assert only the returned view (the public contract).

const todo = (id: string, status: TodoStatus): TodoItem => ({
  id,
  repoKey: '/r',
  text: id,
  status,
  order: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
});

const inProgress: FlowStateView = { stepName: 's', position: 1, total: 1, status: 'in_progress' };

describe('deriveFlowView (§24.2.2 S5 — derived live status)', () => {
  it('augments an in_progress view with activity + n/m done + not-ready', () => {
    const v = deriveFlowView(inProgress, [todo('a', 'done'), todo('b', 'active'), todo('c', 'done')], 'active');
    expect(v.derived).toEqual({ activity: 'active', todosDone: 2, todosTotal: 3, ready: false });
  });

  it('is ready when every todo is done', () => {
    const v = deriveFlowView(inProgress, [todo('a', 'done'), todo('b', 'done')], 'quiet');
    expect(v.derived).toEqual({ activity: 'quiet', todosDone: 2, todosTotal: 2, ready: true });
  });

  it('is ready (vacuously) with no todos', () => {
    const v = deriveFlowView(inProgress, [], 'quiet');
    expect(v.derived).toEqual({ activity: 'quiet', todosDone: 0, todosTotal: 0, ready: true });
  });

  it('counts in_progress todos as outstanding (not done)', () => {
    const v = deriveFlowView(inProgress, [todo('a', 'in_progress'), todo('b', 'done')], 'quiet');
    expect(v.derived).toMatchObject({ todosDone: 1, todosTotal: 2, ready: false });
  });

  it('is pure: same inputs → equal output, and the input view is untouched', () => {
    const todos = [todo('a', 'active')];
    expect(deriveFlowView(inProgress, todos, 'active')).toEqual(deriveFlowView(inProgress, todos, 'active'));
    expect(inProgress.derived).toBeUndefined();
  });

  it('passes a non-in_progress view through unchanged (no step is being worked)', () => {
    const notStarted: FlowStateView = { stepName: 's', position: 1, total: 1, status: 'not_started' };
    expect(deriveFlowView(notStarted, [todo('a', 'active')], 'active')).toEqual(notStarted);
    const done: FlowStateView = { stepName: 's', position: 1, total: 1, status: 'done' };
    expect(deriveFlowView(done, [], 'quiet').derived).toBeUndefined();
  });
});

describe('advanceWithReadinessGate (§19.2 — advance is a human override)', () => {
  const doneView: FlowStateView = { stepName: 's', position: 1, total: 1, status: 'done' };
  const fakeFlow = (todos: TodoItem[]) => ({
    state: () => inProgress,
    advance: () => doneView,
    todos,
  });

  it('attaches the not-ready warning when a todo is still outstanding', () => {
    const flow = fakeFlow([todo('a', 'active')]);
    const v = advanceWithReadinessGate(flow, '/r', flow.todos, 'quiet');
    expect(v.status).toBe('done');
    expect(v.notice).toBe(ADVANCE_NOT_READY_NOTICE);
  });

  it('attaches NO notice when every todo is done (ready)', () => {
    const flow = fakeFlow([todo('a', 'done')]);
    const v = advanceWithReadinessGate(flow, '/r', flow.todos, 'quiet');
    expect(v.status).toBe('done');
    expect(v.notice).toBeUndefined();
  });

  it('reads readiness from the PRE-advance state, not the post-advance done view', () => {
    // The pre-advance view is in_progress with an outstanding todo → not ready → notice; if the
    // gate read the post-advance (done) view, deriveFlowView would yield ready and drop the warning.
    const flow = fakeFlow([todo('a', 'in_progress')]);
    expect(advanceWithReadinessGate(flow, '/r', flow.todos, 'quiet').notice).toBe(ADVANCE_NOT_READY_NOTICE);
  });
});
