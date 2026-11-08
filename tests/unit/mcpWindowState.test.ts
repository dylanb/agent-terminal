import { describe, expect, it } from 'vitest';
import { readWindowState, type WindowStateSource } from '../../src/main/mcpWindowState';
import { APP_LOOP_STATUS_RUN_LESS } from '../../src/main/loopViewV2';
import type { FlowLoopView, FlowStateView } from '../../src/shared/ipc';
import { distinctTodos } from '../helpers/todoFixtures';

const REPO = '/work/repo-a';

const flowView = (over: Partial<FlowStateView>): FlowStateView => ({
  stepName: 'plan',
  steps: ['plan', 'build', 'done'],
  position: 1,
  total: 3,
  status: 'in_progress',
  runStarted: 'started',
  ...over,
});

const gateLoop = (over: Partial<FlowLoopView> = {}): FlowLoopView => ({
  status: 'awaiting-gate',
  iteration: 2,
  pr: 77,
  branch: 'plan-loop/issue-176',
  ready: true,
  humanNeeded: true,
  gateOptions: ['approve', 'request-changes', 'redo', 'polish'],
  appTurn: { step: 'plan', turnKey: 'consolidate-plan' },
  ...over,
});

const source = (over: Partial<WindowStateSource>): WindowStateSource => ({
  windowId: 'window-7',
  repoKey: REPO,
  view: flowView({}),
  selectedFlow: null,
  loopMessage: null,
  todos: [],
  latestRoundReport: null,
  startable: [],
  ...over,
});

describe("read_state's view of its window", () => {
  it('at a waiting loop gate: the flow, the gate with its step, turn and options, the todos, and the Terminate count', () => {
    const todos = distinctTodos(REPO, ['active', 'in_progress', 'done']);
    const state = readWindowState(source({ view: flowView({ loop: gateLoop() }), todos, selectedFlow: 'feature-dev-v3' }));
    expect.soft(state.repo).toEqual({ key: REPO });
    expect.soft(state.flow).toEqual({ selected: 'feature-dev-v3', steps: ['plan', 'build', 'done'], step: 'plan', status: 'in_progress', runStarted: true });
    expect.soft(state.gate).toEqual({ step: 'plan', turn: 'consolidate-plan', options: ['approve', 'request-changes', 'redo', 'polish'], reasons: [], engineDeciding: false });
    expect.soft(state.todos).toEqual([
      { id: 'todo-1', text: 'todo 1 (active)', status: 'active' },
      { id: 'todo-2', text: 'todo 2 (in_progress)', status: 'in_progress' },
      { id: 'todo-3', text: 'todo 3 (done)', status: 'done' },
    ]);
    expect.soft({ window: state.window, terminateTodoCount: state.terminateTodoCount, startable: state.startable, stalledTurn: state.stalledTurn }).toEqual({ window: { id: 'window-7' }, terminateTodoCount: 3, startable: null, stalledTurn: null });
  });

  it("at an auto gate that halted for the operator: every reason that holds, worded as the gate panel shows it", () => {
    const loop = gateLoop({
      autoGate: {
        deciding: false,
        hung: false,
        haltReasons: [{ reason: 'needs-a-human', detail: 'the reviewers disagree on the slice order' }, { reason: 'frozen-tests-changed' }],
      },
    });
    const state = readWindowState(source({ view: flowView({ loop }) }));
    expect(state.gate?.reasons).toEqual(['(a) needs a human: the reviewers disagree on the slice order', '(d) frozen tests changed']);
  });

  it('at an auto gate whose engine decision is in flight: the engine deciding it, with no halt reason', () => {
    const loop = gateLoop({ autoGate: { deciding: true, hung: false, haltReasons: [] } });
    const state = readWindowState(source({ view: flowView({ loop }) }));
    expect(state.gate).toEqual({ step: 'plan', turn: 'consolidate-plan', options: ['approve', 'request-changes', 'redo', 'polish'], reasons: [], engineDeciding: true });
  });

  it('at a manual step: the step gate the strip advances, named by its step alone', () => {
    const state = readWindowState(source({ view: flowView({ stepName: 'done', position: 3 }) }));
    expect(state.gate).toEqual({ step: 'done', turn: null, options: ['approve'], reasons: [], engineDeciding: false });
  });

  it('with no gate waiting while a loop turn works: no gate', () => {
    const state = readWindowState(source({ view: flowView({ loop: gateLoop({ status: 'working', humanNeeded: false, gateOptions: [] }) }) }));
    expect({ gate: state.gate, step: state.flow?.step }).toEqual({ gate: null, step: 'plan' });
  });

  it('with a failed work turn: its step, turn and reason', () => {
    const loop = gateLoop({ status: 'error', humanNeeded: false, gateOptions: [], appTurn: { step: 'plan', turnKey: 'work-plan' }, errorReason: 'no Claude at the prompt' });
    const state = readWindowState(source({ view: flowView({ loop }) }));
    expect(state.stalledTurn).toEqual({ step: 'plan', turn: 'work-plan', reason: 'no Claude at the prompt' });
  });

  it("the window's loop message, which needs no controller to be read", () => {
    const state = readWindowState(source({ loopMessage: { id: 'msg-3', kind: 'error', reason: 'the approve side effect failed: gh exited 1' } }));
    expect(state.loopMessage).toEqual({ id: 'msg-3', kind: 'error', reason: 'the approve side effect failed: gh exited 1' });
  });

  it("the latest round report while the run is at its loop step, and none once the flow has moved past it", () => {
    const report = { round: 2, verdict: 'clean', sections: ['principal'] };
    const atLoop = readWindowState(source({ view: flowView({ loop: gateLoop() }), latestRoundReport: report }));
    const pastLoop = readWindowState(source({ view: flowView({ stepName: 'done', position: 3, loop: gateLoop({ status: 'complete', humanNeeded: false, gateOptions: [] }) }), latestRoundReport: report }));
    expect({ atLoop: atLoop.roundReport, pastLoop: pastLoop.roundReport, pastLoopGate: pastLoop.gate }).toEqual({
      atLoop: report,
      pastLoop: null,
      pastLoopGate: { step: 'done', turn: null, options: ['approve'], reasons: [], engineDeciding: false },
    });
  });

  it('once the flow has finished: no gate', () => {
    const finished = readWindowState(source({ view: flowView({ stepName: 'done', position: 3, status: 'done', loop: gateLoop({ status: 'complete', humanNeeded: false, gateOptions: [] }) }) }));
    expect({ gate: finished.gate, status: finished.flow?.status }).toEqual({ gate: null, status: 'done' });
  });

  it('before Start: the flows and loops the window can start, and no Terminate count', () => {
    const startable = [{ id: 'feature-dev-v3', name: 'Feature dev' }, { id: 'loop:plan-loop', name: 'plan-loop' }];
    const state = readWindowState(source({ view: flowView({ status: 'not_started', runStarted: 'never-started' }), startable, todos: distinctTodos(REPO, ['active']) }));
    expect({ startable: state.startable, terminateTodoCount: state.terminateTodoCount, runStarted: state.flow?.runStarted, selected: state.flow?.selected, gate: state.gate }).toEqual({
      startable,
      terminateTodoCount: null,
      runStarted: false,
      selected: null,
      gate: null,
    });
  });

  it('before Start at a loop step: the options its loop declares are not a waiting gate', () => {
    const runLess = gateLoop({ status: APP_LOOP_STATUS_RUN_LESS, actionable: false, humanNeeded: false, ready: false, pr: null, branch: null, gateOptions: ['approve', 'request-changes'], appTurn: undefined });
    const state = readWindowState(source({ view: flowView({ status: 'not_started', runStarted: 'never-started', loop: runLess }) }));
    expect({ gate: state.gate, step: state.flow?.step }).toEqual({ gate: null, step: 'plan' });
  });
});
