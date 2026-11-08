import { describe, expect, it } from 'vitest';
import { createMcpActions } from '../../src/main/mcpActions';
import { HUMAN_DECIDER, runAppApprove, runAppGateDecisionOutcome } from '../../src/main/appGateDecision';
import { createLoopMessages } from '../../src/main/loopMessages';
import { toolResult, type McpToolResult } from '../../src/main/mcpTools';
import { APP_LOOP_NAMESPACE, RETIRED_LOOP_NAMESPACE } from '../../src/shared/loopNamespace';
import type { McpWindowState } from '../../src/shared/mcpWindowState';
import type { TurnOrigin } from '../../src/shared/turnOrigin';
import { mkDeps } from '../helpers/appGateDecisionDeps';

const TARGET = { window: 'own-window', repo: '/current-repo', step: 'plan', turn: 'consolidate-plan' };
const TOOLS = ['request_changes', 'redo', 'polish', 'retry', 'dismiss_loop_message', 'choose_flow', 'start', 'terminate'] as const;
const stateAtGate = (): McpWindowState => ({
  window: { id: TARGET.window }, repo: { key: TARGET.repo },
  flow: { selected: 'feature', steps: ['plan', 'done'], step: 'plan', status: 'in_progress', runStarted: true },
  selectionUnusable: false,
  gate: { step: 'plan', turn: TARGET.turn, options: ['approve', 'request-changes', 'redo', 'polish'], reasons: [], engineDeciding: false },
  stalledTurn: null, loopMessage: null, roundReport: null, todos: [], startable: null, startableError: null, terminateTodoCount: 0,
});

function fixture(opts: { origin?: TurnOrigin; state?: McpWindowState; busy?: boolean; polishError?: string; held?: boolean; retired?: boolean; required?: boolean; resolved?: boolean; operationResult?: { kind: string; message: string } } = {}) {
  const state = structuredClone(opts.state ?? stateAtGate());
  const messages = createLoopMessages(() => {});
  messages.post('error', 'the work turn failed');
  state.loopMessage = messages.current();
  const savedInputs: Record<string, string> = opts.resolved ? { ticket: '322' } : {};
  const { deps, rec } = mkDeps({
    gate: [{ option: 'approve', sideEffects: [] }, { option: 'request-changes', sideEffects: [] }, { option: 'redo', sideEffects: [] }, { option: 'polish', sideEffects: [] }],
    ...(opts.busy ? { deliverFeedback: () => false, deliverRedo: () => false } : {}),
    ...(opts.polishError ? { enterPolish: () => { throw new Error(opts.polishError); } } : {}),
  });
  const ports = {
    windowId: TARGET.window,
    originOf: async (): Promise<TurnOrigin> => opts.origin ?? 'human',
    readState: async () => ({ ...structuredClone(state), loopMessage: messages.current() }),
    readGateState: () => structuredClone(state),
    gate: {
      autoGate: { humanDecision: () => () => {} },
      pickupHold: () => opts.held ? 'Confirm the run ticket first' : null,
      bindingOf: () => opts.retired ? RETIRED_LOOP_NAMESPACE : APP_LOOP_NAMESPACE,
      approve: (repo: string, step: string, turn: string) => runAppApprove(repo, step, turn, deps, HUMAN_DECIDER),
      decide: (repo: string, step: string, turn: string, option: 'request-changes' | 'redo' | 'polish', note?: string) => runAppGateDecisionOutcome(repo, step, turn, option, deps, note),
    },
    retry: (_repo: string, _step: string, _turn: string) => { state.stalledTurn = null; return { taken: true as const }; },
    dismissLoopMessage: (id: string) => messages.dismiss(id),
    chooseFlow: (_repo: string, id: string) => { if (state.flow) state.flow.selected = id; return { ok: true }; },
    entryInputs: () => opts.required ? [{ name: 'ticket', type: 'github-ticket', required: true, ...(opts.resolved ? { value: '322' } : {}) }] : [],
    start: (_repo: string, inputs: Record<string, string>) => { Object.assign(savedInputs, inputs); if (state.flow) { state.flow.status = 'in_progress'; state.flow.runStarted = true; } return opts.operationResult ?? { kind: 'started' }; },
    terminate: (_repo: string) => { if (state.flow) { state.flow.status = 'not_started'; state.flow.runStarted = false; } state.todos = []; return { kind: 'terminated' }; },
    advance: (_repo: string, _step: string, inputs: Record<string, string>) => { Object.assign(savedInputs, inputs); if (state.flow) state.flow.step = 'done'; state.gate = null; return opts.operationResult ?? { kind: 'advanced' }; },
  };
  const actions = createMcpActions(ports);
  const snapshot = () => ({ state: structuredClone(state), message: messages.current(), inputs: { ...savedInputs }, outputs: structuredClone({ feedbacks: rec.feedbacks, redos: rec.redos, accepts: rec.accepts, advances: rec.advances, polish: rec.polishEnters, errors: rec.errors, notices: rec.notices }) });
  const call = async (tool: string, args: Record<string, unknown>): Promise<McpToolResult> => {
    try { return toolResult({ kind: 'answered', value: await actions.call({ tool, args }, { session: 501 }) }); }
    catch (error) { return { isError: true, content: [{ type: 'text', text: String(error) }] }; }
  };
  const args = (tool: string): Record<string, unknown> => {
    const own = { window: state.window.id, repo: state.repo?.key };
    if (tool === 'choose_flow') return { ...own, flow: 'other' };
    if (tool === 'start') return { ...own, inputs: {} };
    if (tool === 'terminate') return { ...own, expectedTodoCount: state.terminateTodoCount };
    if (tool === 'dismiss_loop_message') return { ...own, message: state.loopMessage?.id };
    return { ...own, step: state.gate?.step ?? state.stalledTurn?.step ?? 'plan', turn: state.gate?.turn ?? state.stalledTurn?.turn ?? TARGET.turn,
      ...(tool === 'request_changes' ? { feedback: 'Keep the exact feedback: $x; "quoted"\nsecond line' } : {}),
      ...(tool === 'redo' ? { instruction: 'Start again with the empty-list case' } : {}) };
  };
  return { call, args, snapshot, state, savedInputs, rec, messages };
}

const said = (result: McpToolResult): string => result.content.map(c => c.text).join('\n');
const reasons = {
  window: /not this session.s window/i,
  undetermined: /turn origin could not be determined/i,
  injected: /not a human-started turn/i,
  gate: /no gate waiting/i,
  state: /not valid in the current state/i,
};

for (const tool of TOOLS) {
  describe(tool, () => {
    it.each([
      ['wrong window first', 'not-human', true, reasons.window],
      ['unknown origin', 'undetermined', false, reasons.undetermined],
      ['injected turn', 'not-human', false, reasons.injected],
    ] as const)('refuses %s before state checks and changes nothing', async (_name, origin, otherWindow, reason) => {
      const state = stateAtGate(); state.gate = null;
      const f = fixture({ origin, state });
      const before = f.snapshot();
      const result = await f.call(tool, { ...f.args(tool), ...(otherWindow ? { window: 'other-window' } : {}) });
      expect({ error: result.isError, reason: said(result), after: f.snapshot() }).toEqual({ error: true, reason: expect.stringMatching(reason), after: before });
    });

    it('refuses a different repository with its current identity and changes nothing', async () => {
      const f = fixture(); const before = f.snapshot();
      const result = await f.call(tool, { ...f.args(tool), repo: '/old-repo' });
      expect({ error: result.isError, notValid: reasons.state.test(said(result)), namesRepo: said(result).includes(TARGET.repo), after: f.snapshot() }).toEqual({ error: true, notValid: true, namesRepo: true, after: before });
    });
  });
}

for (const tool of ['request_changes', 'redo', 'polish'] as const) {
  it(`${tool} with no gate refuses no gate waiting`, async () => {
    const state = stateAtGate(); state.gate = null;
    const f = fixture({ state }); const before = f.snapshot();
    const result = await f.call(tool, f.args(tool));
    expect({ reason: said(result), after: f.snapshot() }).toEqual({ reason: expect.stringMatching(reasons.gate), after: before });
  });
  it.each(['step', 'turn', 'option', 'pickup', 'retired'] as const)(`${tool} refuses stale or unavailable %s without changing state or delivering output`, async (which) => {
    const state = stateAtGate(); if (which === 'option' && state.gate) state.gate.options = ['approve'];
    const f = fixture({ state, held: which === 'pickup', retired: which === 'retired' }); const before = f.snapshot();
    const result = await f.call(tool, { ...f.args(tool), ...(['step', 'turn'].includes(which) ? { [which]: 'stale' } : {}) });
    expect({ error: result.isError, reason: said(result), after: f.snapshot() }).toEqual({ error: true, reason: expect.stringMatching(reasons.state), after: before });
  });
}

for (const [tool, field] of [['request_changes', 'feedback'], ['redo', 'instruction']] as const) {
  it(`${tool} delivers the supplied text to its own step and turn, without accepting or advancing`, async () => {
    const f = fixture(); const args = f.args(tool);
    const result = await f.call(tool, args);
    expect({ error: result.isError, deliveries: tool === 'redo' ? f.rec.redos : f.rec.feedbacks, accepts: f.rec.accepts, advances: f.rec.advances }).toEqual({
      error: false, deliveries: [{ step: TARGET.step, turnKey: TARGET.turn, [field]: args[field] }], accepts: [], advances: [],
    });
  });
  it(`${tool} refuses blank text without altering gate state or posting a message`, async () => {
    const f = fixture(); const before = f.snapshot();
    const result = await f.call(tool, { ...f.args(tool), [field]: ' \n ' });
    expect({ error: result.isError, reason: said(result), after: f.snapshot() }).toEqual({ error: true, reason: expect.stringMatching(reasons.state), after: before });
  });
  it(`${tool} dropped by a busy runner is neither success nor refusal and tells the operator to resend`, async () => {
    const f = fixture({ busy: true });
    const result = await f.call(tool, f.args(tool));
    expect({ error: result.isError, busy: /busy/i.test(said(result)), resend: /resend|send.*again/i.test(said(result)), refusal: Object.values(reasons).some(r => r.test(said(result))), accepts: f.rec.accepts, advances: f.rec.advances }).toEqual({ error: true, busy: true, resend: true, refusal: false, accepts: [], advances: [] });
  });
}

it('polish enters the current step without accepting or advancing', async () => {
  const f = fixture(); const result = await f.call('polish', f.args('polish'));
  expect({ error: result.isError, polish: f.rec.polishEnters, accepts: f.rec.accepts, advances: f.rec.advances }).toEqual({ error: false, polish: [{ repoDir: TARGET.repo, step: TARGET.step }], accepts: [], advances: [] });
});
it('polish that cannot be entered is neither success nor refusal, naming its failure and keeping the Loop error', async () => {
  const f = fixture({ polishError: 'EACCES on polish state' }); const result = await f.call('polish', f.args('polish'));
  expect({ error: result.isError, reason: said(result), refusal: Object.values(reasons).some(r => r.test(said(result))), errors: f.rec.errors }).toEqual({ error: true, reason: expect.stringContaining('EACCES'), refusal: false, errors: [expect.stringContaining('EACCES')] });
});
it('retry targets the stalled turn even when no gate is waiting', async () => {
  const state = stateAtGate(); state.gate = null; state.stalledTurn = { step: 'plan', turn: 'work-2', reason: 'stalled' };
  const f = fixture({ state }); const result = await f.call('retry', f.args('retry'));
  expect({ error: result.isError, stalled: f.state.stalledTurn }).toEqual({ error: false, stalled: null });
});
it.each(['none', 'stale'] as const)('retry refuses a %s stopped turn as not valid, never no gate waiting', async which => {
  const state = stateAtGate(); state.gate = null; state.stalledTurn = which === 'none' ? null : { step: 'plan', turn: 'new-turn', reason: 'failed' };
  const f = fixture({ state }); const before = f.snapshot();
  const result = await f.call('retry', { ...f.args('retry'), turn: 'old-turn' });
  expect({ error: result.isError, reason: said(result), after: f.snapshot() }).toEqual({ error: true, reason: expect.stringMatching(reasons.state), after: before });
});
it('dismiss clears exactly the message returned by read_state without a waiting gate', async () => {
  const state = stateAtGate(); state.gate = null;
  const f = fixture({ state }); const read = await f.call('read_state', {});
  const current = JSON.parse(said(read)) as McpWindowState;
  const result = await f.call('dismiss_loop_message', { window: current.window.id, repo: current.repo?.key, message: current.loopMessage?.id });
  expect({ error: result.isError, message: f.messages.current() }).toEqual({ error: false, message: null });
});
it.each(['replaced', 'absent'] as const)('dismiss refuses an %s message and preserves its replacement', async which => {
  const f = fixture(); const args = f.args('dismiss_loop_message');
  if (which === 'replaced') f.messages.post('notice', 'newer message'); else f.messages.dismiss(String(args.message));
  const before = f.snapshot(); const result = await f.call('dismiss_loop_message', args);
  expect({ error: result.isError, reason: said(result), after: f.snapshot() }).toEqual({ error: true, reason: expect.stringMatching(reasons.state), after: before });
});

it('a step gate is approved by step identity only, advances, and reports outstanding todos', async () => {
  const state = stateAtGate(); if (state.gate) state.gate.turn = null; state.todos = [{ id: 't', text: 'unfinished', status: 'active' }];
  const f = fixture({ state }); const result = await f.call('approve', { window: TARGET.window, repo: TARGET.repo, step: TARGET.step });
  expect({ error: result.isError, step: f.state.flow?.step, notice: said(result), accepts: f.rec.accepts }).toEqual({ error: false, step: 'done', notice: expect.stringMatching(/todos.*outstanding|outstanding.*todos/i), accepts: [] });
});
it('a step-only approve cannot override a waiting loop gate', async () => {
  const f = fixture(); const before = f.snapshot();
  const result = await f.call('approve', { window: TARGET.window, repo: TARGET.repo, step: TARGET.step });
  expect({ error: result.isError, reason: said(result), after: f.snapshot() }).toEqual({ error: true, reason: expect.stringMatching(reasons.state), after: before });
});

for (const tool of ['choose_flow', 'start'] as const) {
  it(`${tool} refuses an already started run`, async () => {
    const f = fixture(); const before = f.snapshot(); const result = await f.call(tool, f.args(tool));
    expect({ error: result.isError, reason: said(result), after: f.snapshot() }).toEqual({ error: true, reason: expect.stringMatching(reasons.state), after: before });
  });
}
it('choose_flow accepts the identity read_state lists and selects it before start', async () => {
  const state = stateAtGate(); state.gate = null; state.startable = [{ id: 'other', name: 'Other workflow' }];
  if (state.flow) { state.flow.status = 'not_started'; state.flow.runStarted = false; }
  const f = fixture({ state }); const read = JSON.parse(said(await f.call('read_state', {}))) as McpWindowState;
  const result = await f.call('choose_flow', { window: read.window.id, repo: read.repo?.key, flow: read.startable?.[0].id });
  expect({ error: result.isError, selected: f.state.flow?.selected }).toEqual({ error: false, selected: 'other' });
});
it('choose_flow refuses an unknown catalog identity', async () => {
  const state = stateAtGate(); state.gate = null; state.startable = [{ id: 'other', name: 'Other' }];
  if (state.flow) { state.flow.status = 'not_started'; state.flow.runStarted = false; }
  const f = fixture({ state }); const before = f.snapshot(); const result = await f.call('choose_flow', { ...f.args('choose_flow'), flow: 'missing' });
  expect({ error: result.isError, reason: said(result), after: f.snapshot() }).toEqual({ error: true, reason: expect.stringMatching(reasons.state), after: before });
});
it.each([null, 2] as const)('terminate refuses with current count when the count is %s instead of the supplied zero', async count => {
  const state = stateAtGate(); state.terminateTodoCount = count;
  if (count === null && state.flow) { state.flow.status = 'not_started'; state.flow.runStarted = false; }
  const f = fixture({ state }); const before = f.snapshot(); const result = await f.call('terminate', { ...f.args('terminate'), expectedTodoCount: 0 });
  expect({ error: result.isError, reason: said(result), namesCount: count === null || said(result).includes('2'), after: f.snapshot() }).toEqual({ error: true, reason: expect.stringMatching(reasons.state), namesCount: true, after: before });
});

for (const tool of ['start', 'approve'] as const) {
  const setup = (extra: Parameters<typeof fixture>[0] = {}) => {
    const state = stateAtGate();
    if (tool === 'start') { state.gate = null; if (state.flow) { state.flow.status = 'not_started'; state.flow.runStarted = false; } }
    else if (state.gate) state.gate.turn = null;
    const f = fixture({ state, required: true, ...extra });
    const args = { window: TARGET.window, repo: TARGET.repo, ...(tool === 'approve' ? { step: TARGET.step } : {}) };
    return { f, args };
  };
  it(`${tool} provides the required ticket at entry without a second input request`, async () => {
    const { f, args } = setup(); const result = await f.call(tool, { ...args, inputs: { ticket: '322' } });
    expect({ error: result.isError, inputs: f.savedInputs, entered: tool === 'start' ? f.state.flow?.runStarted : f.state.flow?.step === 'done' }).toEqual({ error: false, inputs: { ticket: '322' }, entered: true });
  });
  it.each([undefined, {}, { ticket: 'not-a-ticket' }] as const)(`${tool} refuses missing or invalid required inputs %j before side effects`, async inputs => {
    const { f, args } = setup(); const before = f.snapshot();
    const result = await f.call(tool, { ...args, ...(inputs === undefined ? {} : { inputs }) });
    expect({ error: result.isError, reason: reasons.state.test(said(result)), namesInput: said(result).includes('ticket'), after: f.snapshot() }).toEqual({ error: true, reason: true, namesInput: true, after: before });
  });
  it(`${tool} needs no value for an already resolved input`, async () => {
    const { f, args } = setup({ resolved: true }); const result = await f.call(tool, args);
    expect({ error: result.isError, entered: tool === 'start' ? f.state.flow?.runStarted : f.state.flow?.step === 'done' }).toEqual({ error: false, entered: true });
  });
  it(`${tool} reports pickup started when entry starts pickup, without claiming pickup finished`, async () => {
    const { f, args } = setup({ operationResult: { kind: 'pickup-started', message: 'Taken; pickup started' } });
    const result = await f.call(tool, { ...args, inputs: { ticket: '322' } });
    expect({ error: result.isError, pickup: /pickup.*started/i.test(said(result)), finished: /pickup.*(finished|completed)/i.test(said(result)) }).toEqual({ error: false, pickup: true, finished: false });
  });
}

it('terminate acts with the read count and clears the run and its todos', async () => {
  const state = stateAtGate(); state.todos = [{ id: 't', text: 'work', status: 'active' }]; state.terminateTodoCount = 1;
  const f = fixture({ state }); const current = JSON.parse(said(await f.call('read_state', {}))) as McpWindowState;
  const result = await f.call('terminate', { window: current.window.id, repo: current.repo?.key, expectedTodoCount: current.terminateTodoCount });
  expect({ error: result.isError, status: f.state.flow?.status, started: f.state.flow?.runStarted, todos: f.state.todos }).toEqual({ error: false, status: 'not_started', started: false, todos: [] });
});
