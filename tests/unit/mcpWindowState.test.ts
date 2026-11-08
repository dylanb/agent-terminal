import { describe, expect, it } from 'vitest';
import { readWindowState, catalogView, reviewedRound, type WindowStateSource } from '../../src/main/mcpWindowState';
import { APP_LOOP_STATUS_RUN_LESS } from '../../src/main/loopViewV2';
import type { FlowCatalogListResult, FlowCatalogSelection, FlowLoopView, FlowStateView } from '../../src/shared/ipc';
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

  it("with a failed work turn: its reason as the loop panel shows it, and none where the panel shows no reason row", () => {
    const failed = (errorReason: string) => readWindowState(source({ view: flowView({ loop: gateLoop({ status: 'error', humanNeeded: false, gateOptions: [], appTurn: { step: 'plan', turnKey: 'work-plan' }, errorReason }) }) })).stalledTurn?.reason;
    expect({ escaped: failed('gh \u001b[31mexited\u001b[0m 1'), empty: failed('') }).toEqual({ escaped: 'gh  [31mexited [0m 1', empty: null });
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

  it("the round whose report is read: the run state's round once it records the round's verdict, else the one before it", () => {
    const inLoop = (over: Partial<FlowLoopView>) => flowView({ loop: gateLoop({ status: 'running', humanNeeded: false, gateOptions: [], ...over }) });
    expect({
      reviewed: reviewedRound(flowView({ loop: gateLoop({ iteration: 2, verdict: 'clean' }) })),
      reviewing: reviewedRound(inLoop({ iteration: 2 })),
      firstRound: reviewedRound(inLoop({ iteration: 1 })),
      noRound: reviewedRound(inLoop({ iteration: undefined })),
      pastLoopStep: reviewedRound(flowView({ stepName: 'done', position: 3, loop: gateLoop({ iteration: 2, verdict: 'clean', status: 'complete' }) })),
    }).toEqual({ reviewed: 2, reviewing: 1, firstRound: null, noRound: null, pastLoopStep: null });
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

describe("read_state's startable flows, from the picker's catalog listing", () => {
  it('lists the entries the picker lets the operator choose, and names a listing that failed', () => {
    const listed = catalogView({
      ok: true,
      listing: {
        entries: [
          { available: true, id: 'feature-dev-v3', origin: 'global' },
          { available: false, label: 'broken.yaml', origin: 'repo', reason: 'not valid YAML' },
        ],
        tierNotices: [],
        selection: { kind: 'unset' },
        recoveryOutcomes: [],
      },
    });
    const failed = catalogView({ ok: false, reason: 'the catalog directory is unreadable' });
    const before = (catalog: ReturnType<typeof catalogView>) =>
      readWindowState(source({ view: flowView({ status: 'not_started', runStarted: 'never-started' }), ...catalog }));
    expect({ listed: before(listed), failed: before(failed) }).toMatchObject({
      listed: { startable: [{ id: 'feature-dev-v3', name: 'feature-dev-v3' }], startableError: null },
      failed: { startable: [], startableError: expect.stringContaining('the catalog directory is unreadable') },
    });
  });
});

describe("read_state's view of the flow the picker has selected", () => {
  it('names a usable pick, says an unusable pick is unusable rather than that the default runs, and claims nothing for a failed listing', () => {
    const listing = (selection: FlowCatalogSelection): FlowCatalogListResult => ({
      ok: true,
      listing: { entries: [{ available: true, id: 'feature-dev-v3', origin: 'global' }], tierNotices: [], selection, recoveryOutcomes: [] },
    });
    const read = (catalog: FlowCatalogListResult) => {
      const state = readWindowState(source({ view: flowView({ status: 'not_started', runStarted: 'never-started' }), ...catalogView(catalog) }));
      return { selected: state.flow?.selected, unusable: state.selectionUnusable };
    };
    expect({
      picked: read(listing({ kind: 'value', id: 'feature-dev-v3' })),
      unusable: read(listing({ kind: 'invalid' })),
      unset: read(listing({ kind: 'unset' })),
      failed: read({ ok: false, reason: 'unreadable' }),
    }).toEqual({
      picked: { selected: 'feature-dev-v3', unusable: false },
      unusable: { selected: null, unusable: true },
      unset: { selected: null, unusable: false },
      failed: { selected: null, unusable: false },
    });
  });
});

describe("read_state's Terminate count and step gate, offered as the strip offers them", () => {
  it('names the count wherever the strip offers Terminate, the step gate wherever it offers Advance, and neither before Start', () => {
    const todos = distinctTodos(REPO, ['active', 'done']);
    const read = (over: Partial<FlowStateView>) => {
      const state = readWindowState(source({ view: flowView({ stepName: 'done', position: 3, ...over }), todos }));
      return { count: state.terminateTodoCount, gate: state.gate?.step ?? null, runStarted: state.flow?.runStarted };
    };
    expect({
      heldInProgress: read({ status: 'in_progress', runStarted: 'indeterminate' }),
      heldAtError: read({ status: 'error', runStarted: 'indeterminate', steps: [] }),
      finished: read({ status: 'done', runStarted: 'started' }),
      beforeStart: read({ status: 'not_started', runStarted: 'never-started' }),
    }).toEqual({
      heldInProgress: { count: 2, gate: 'done', runStarted: true },
      heldAtError: { count: 2, gate: null, runStarted: true },
      finished: { count: 2, gate: null, runStarted: true },
      beforeStart: { count: null, gate: null, runStarted: false },
    });
  });
});

describe("read_state's reasons a loop gate waits", () => {
  it("include the round's verdict the gate panel shows, and its reason under stop for a human, stripped as the panel strips them", () => {
    const stopped = readWindowState(source({ view: flowView({ loop: gateLoop({ verdict: 'stop for a human', verdictReason: 'the slices\u001b[31m overlap' }) }) }));
    const clean = readWindowState(source({ view: flowView({ loop: gateLoop({ verdict: 'clean' }) }) }));
    expect({ stopped: stopped.gate?.reasons, clean: clean.gate?.reasons }).toEqual({
      stopped: ['verdict: stop for a human', 'verdict reason: the slices [31m overlap'],
      clean: ['verdict: clean'],
    });
  });
});

describe("read_state's verdict rows at a loop gate", () => {
  it('leave out a verdict reason that is empty, as the gate panel shows no row for it', () => {
    const state = readWindowState(source({ view: flowView({ loop: gateLoop({ verdict: 'stop for a human', verdictReason: '' }) }) }));
    expect(state.gate?.reasons).toEqual(['verdict: stop for a human']);
  });
});
