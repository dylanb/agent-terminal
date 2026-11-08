import { isMcpToolName, type McpToolName } from '../shared/mcp';
import type { McpCaller, WindowAnswerFailure, WindowRequest } from '../shared/mcpBridge';
import type { McpWindowState } from '../shared/mcpWindowState';
import type { TurnOrigin } from '../shared/turnOrigin';
import type { GateApproveOutcome, GateDecisionOutcome } from './appGateDecision';
import type { AppRetryOutcome } from './appLoopEngine';
import type { AutoGate } from './autoGate';
import { APPROVE_ALREADY_RUNNING, approveRunning, composeHumanApprove, humanApproveRefusal, type HumanApproveDeps } from './autoGateComposition';
import { invalidToolArguments } from './mcpTools';

/** The loop gate an approve acts on, as `read_state` names it. */
export interface GateTarget {
  repoKey: string;
  step: string;
  turnKey: string;
}

export interface McpActionDeps {
  windowId: string;
  originOf(caller: McpCaller): Promise<TurnOrigin>;
  readState(): Promise<McpWindowState>;
  readGateState(): Pick<McpWindowState, 'repo' | 'gate'>;
  readActionState?: () => McpWindowState;
  entryStatus?: (repo: string) => { kind: string; message: string } | null;
  /** What the window's own Approve control decides with: an MCP approve runs the same human approve over them. */
  gate: HumanApproveDeps & {
    autoGate: Pick<AutoGate, 'humanDecision'>;
    decide?: (repo: string, step: string, turn: string, option: 'request-changes' | 'redo' | 'polish', note?: string) => Promise<GateDecisionOutcome>;
  };
  retry?: (repo: string, step: string, turn: string) => AppRetryOutcome | void;
  dismissLoopMessage?: (id: string) => void;
  chooseFlow?: (repo: string, id: string) => { ok: boolean; reason?: string };
  entryInputs?: (repo: string, action: 'start' | 'approve') => { name: string; type: string; required: boolean; value?: string }[];
  start?: (repo: string, inputs: Record<string, string>) => { kind: string; message?: string };
  terminate?: (repo: string) => { kind: string; message?: string };
  advance?: (repo: string, step: string, inputs: Record<string, string>) => { kind: string; message?: string };
}

/** The ticket's refusal reasons a window gives, in the order it checks them; app unreachable is the server's. */
type RefusalKind = 'not-this-window' | 'origin-undetermined' | 'not-human-started' | 'no-gate-waiting' | 'not-valid';

const REFUSAL_WORDING: Record<RefusalKind, string> = {
  'not-this-window': "Not this session's window",
  'origin-undetermined': 'Turn origin could not be determined',
  'not-human-started': 'Not a human-started turn',
  'no-gate-waiting': 'No gate waiting',
  'not-valid': 'Not valid in the current state',
};

const refusal = (kind: RefusalKind, detail: string): WindowAnswerFailure => ({
  outcome: 'refusal',
  kind,
  message: `${REFUSAL_WORDING[kind]}: ${detail} Nothing was changed.`,
});

const neither = (kind: string, message: string): WindowAnswerFailure => ({ outcome: 'neither', kind, message });

const ORIGIN_REFUSALS: Record<Exclude<TurnOrigin, 'human'>, WindowAnswerFailure> = {
  undetermined: refusal('origin-undetermined', 'agent-terminal could not tell who started this turn, so it does not act on it. Ask the operator to type the request in the window, or send it over Remote Control.'),
  'not-human': refusal('not-human-started', 'this turn was not started by a prompt the operator typed, so it cannot decide a gate. Ask the operator to type the request in the window, or send it over Remote Control.'),
};

const quote = (value: string): string => JSON.stringify(value);

/** What an approve the gate ran returns to the agent. */
function approveAnswer(outcome: GateApproveOutcome, at: string): unknown {
  switch (outcome.kind) {
    case 'advanced':
      return outcome.effectFailures.length === 0
        ? { kind: 'taken', message: `Approved: the gate at ${at} is taken and the flow advanced.` }
        : {
            kind: 'taken-side-effect-failed',
            message: `Approved: the gate at ${at} is taken and the flow advanced, but these side effects failed: ${outcome.effectFailures.join('; ')}.`,
          };
    case 'held':
      return neither(
        'side-effect-failed',
        `Not taken: a side effect of the gate at ${at} failed (${outcome.effectFailures.join('; ')}), so the gate still waits. Approving again re-runs every side effect.`,
      );
    case 'accept-failed':
      return neither('accept-not-saved', `Not taken: the accept of the gate at ${at} could not be saved: ${outcome.reason}. The gate still waits.`);
    case 'preview-raised':
      return {
        kind: 'waiting-on-dialog',
        message: `Waiting on the epic-promotion preview the window shows at the machine for the gate at ${at}: the gate is decided only when the operator confirms the preview there.`,
      };
    case 'blocked':
      return neither('epic-promotion-blocked', `Not taken: epic promotion is blocked for the gate at ${at}; the window shows why.`);
    case 'refused':
      return neither('not-taken', `Not taken: the gate at ${at} moved on before the approve ran (${outcome.reason}). Read the state again.`);
    case 'refused-late':
      return neither('not-taken', `Not taken: the gate at ${at} was decided otherwise (${outcome.reasons.join(', ')}).`);
    case 'abandoned':
    case 'run-ended':
    case 'stood-down':
      return neither('not-taken', `Not taken: the gate at ${at} was ${outcome.kind === 'run-ended' ? 'ended with its run' : 'decided by another approve'}.`);
    default:
      return outcome satisfies never;
  }
}

interface ActionArguments {
  window: string;
  repo: string;
  step: string;
  turn: string;
  feedback?: string;
  instruction?: string;
  message: string;
  flow: string;
  inputs?: Record<string, string>;
  expectedTodoCount: number;
}

/** The window's answer to a tool call, which the server turns into the call's tool result. */
export function createMcpActions(deps: McpActionDeps): { call(request: WindowRequest, caller: McpCaller): Promise<unknown> } {
  const humanApprove = composeHumanApprove(deps.gate.autoGate, deps.gate);

  const checkInputs = (args: ActionArguments, action: 'start' | 'approve'): WindowAnswerFailure | null => {
    const declared = deps.entryInputs?.(args.repo, action) ?? [];
    for (const name of Object.keys(args.inputs ?? {})) {
      if (!declared.some(input => input.name === name)) return refusal('not-valid', `input ${quote(name)} is not declared by the step being entered.`);
    }
    for (const input of declared) {
      const supplied = Object.hasOwn(args.inputs ?? {}, input.name);
      if (!input.required && !supplied) continue;
      const value = supplied ? args.inputs?.[input.name] : input.value;
      if (!value?.trim()) return refusal('not-valid', `provide the required input ${quote(input.name)}.`);
      if ((input.type === 'github-ticket' || input.type === 'pr') && !/^[1-9]\d*$/.test(value)) return refusal('not-valid', `input ${quote(input.name)} must be a positive issue or pull request number.`);
    }
    return null;
  };
  const act = async (tool: Exclude<McpToolName, 'read_state' | 'approve'>, args: ActionArguments, caller: McpCaller): Promise<unknown> => {
    if (args.window !== deps.windowId) return refusal('not-this-window', `this session's window is ${quote(deps.windowId)}.`);
    const origin = await deps.originOf(caller);
    if (origin !== 'human') return ORIGIN_REFUSALS[origin];
    const state = deps.readActionState ? deps.readActionState() : await deps.readState();
    const decidesGate = tool === 'request_changes' || tool === 'redo' || tool === 'polish';
    if (decidesGate && state.gate === null) return refusal('no-gate-waiting', 'the window is not waiting at a gate.');
    if (state.repo?.key !== args.repo) return refusal('not-valid', `the current repository is ${quote(state.repo?.key ?? 'none')}. Read the state again.`);
    switch (tool) {
      case 'request_changes':
      case 'redo':
      case 'polish': {
        const gate = state.gate!;
        const option = tool === 'request_changes' ? 'request-changes' : tool;
        if (gate.turn === null || gate.step !== args.step || gate.turn !== args.turn || !gate.options.includes(option)) return refusal('not-valid', `the current gate is ${quote(gate.step)}, turn ${quote(gate.turn ?? 'none')}, offering ${gate.options.join(', ')}.`);
        const held = approveRunning(deps.gate.autoGate, args.repo, args.step, args.turn)
          ? APPROVE_ALREADY_RUNNING
          : humanApproveRefusal(deps.gate, args.repo, args.step);
        if (held !== null) return refusal('not-valid', held);
        const note = tool === 'request_changes' ? args.feedback : args.instruction;
        if (tool !== 'polish' && !note?.trim()) return refusal('not-valid', 'provide nonblank feedback or an instruction.');
        if (!deps.gate.decide) return refusal('not-valid', 'gate decisions are unavailable.');
        const settled = deps.gate.autoGate.humanDecision(args.repo, args.step, args.turn);
        let landed = false;
        try {
          const outcome = await deps.gate.decide(args.repo, args.step, args.turn, option, note);
          landed = outcome.taken;
          if (landed) return { kind: 'taken', message: `${tool} taken at ${quote(args.step)}.` };
          return neither('not-taken', outcome.taken ? 'The gate was not taken.' : outcome.reason);
        } finally { settled(landed); }
      }
      case 'retry':
        { const held = deps.gate.pickupHold(args.repo); if (held !== null) return refusal('not-valid', held); }
        if (!state.stalledTurn || state.stalledTurn.step !== args.step || state.stalledTurn.turn !== args.turn || !deps.retry) return refusal('not-valid', 'the stopped turn no longer matches; read the state again.');
        { const outcome = deps.retry(args.repo, args.step, args.turn);
          return outcome?.taken ? { kind: 'retried', message: 'The stopped turn was retried.' }
            : neither('not-taken', outcome?.reason ?? 'The stopped turn was not retried.'); }
      case 'dismiss_loop_message':
        if (state.loopMessage?.id !== args.message || !deps.dismissLoopMessage) return refusal('not-valid', 'the message no longer matches; read the state again.');
        deps.dismissLoopMessage(args.message);
        return { kind: 'dismissed', message: 'The loop message was dismissed.' };
      case 'choose_flow':
        if (state.flow?.runStarted || !state.startable?.some(item => item.id === args.flow) || !deps.chooseFlow) return refusal('not-valid', 'choose an available flow before a run starts.');
        { const result = deps.chooseFlow(args.repo, args.flow);
          return result.ok ? { kind: 'selected', message: `Selected ${quote(args.flow)}.` } : refusal('not-valid', result.reason ?? 'the flow could not be selected.'); }
      case 'start': {
        if (state.flow?.runStarted || state.selectionUnusable || !deps.start) return refusal('not-valid', 'the selected flow cannot start in this state.');
        const invalid = checkInputs(args, 'start');
        return invalid ?? deps.start(args.repo, args.inputs ?? {});
      }
      case 'terminate':
        if (state.terminateTodoCount === null || state.terminateTodoCount !== args.expectedTodoCount || !deps.terminate) return refusal('not-valid', `the current termination todo count is ${state.terminateTodoCount ?? 'unavailable'}. Read the state again.`);
        return deps.terminate(args.repo);
      default:
        return tool satisfies never;
    }
  };

  const approve = async (args: ActionArguments, caller: McpCaller): Promise<unknown> => {
    if (args.window !== deps.windowId) return refusal('not-this-window', `this session's window is ${quote(deps.windowId)}, not ${quote(args.window)}.`);
    const origin = await deps.originOf(caller);
    if (origin !== 'human') return ORIGIN_REFUSALS[origin];
    const state = deps.readGateState();
    const gate = state.gate;
    if (gate === null || state.repo === null) return refusal('no-gate-waiting', 'the window is not waiting at a gate.');
    const shown = `step ${quote(gate.step)}${gate.turn === null ? '' : `, turn ${quote(gate.turn)}`} of ${quote(state.repo.key)}`;
    if (gate.turn === null) {
      if (args.repo !== state.repo.key || args.step !== gate.step || args.turn !== undefined) return refusal('not-valid', `the window waits at ${shown}. Read the state again.`);
      const held = deps.gate.pickupHold(args.repo);
      if (held !== null) return refusal('not-valid', held);
      const invalid = checkInputs(args, 'approve');
      if (invalid !== null) return invalid;
      if (!deps.advance) return refusal('not-valid', 'step advancement is unavailable.');
      const outcome = deps.advance(args.repo, args.step, args.inputs ?? {});
      const outstanding = (await deps.readState()).todos.some(todo => todo.status !== 'done');
      return outstanding ? { ...outcome, message: `${outcome.message ?? 'Advanced.'} Todos are still outstanding.` } : outcome;
    }
    const target: GateTarget = { repoKey: args.repo, step: args.step, turnKey: args.turn };
    if (target.repoKey !== state.repo.key || target.step !== gate.step || target.turnKey !== gate.turn) {
      return refusal('not-valid', `the window waits at the gate of ${shown}, not ${quote(target.step)}, ${quote(target.turnKey)} of ${quote(target.repoKey)}. Read the state again.`);
    }
    if (!gate.options.includes('approve')) return refusal('not-valid', `the gate of ${shown} offers ${gate.options.map(quote).join(', ')}, not approve.`);
    const undecidable = approveRunning(deps.gate.autoGate, target.repoKey, target.step, target.turnKey)
      ? APPROVE_ALREADY_RUNNING
      : humanApproveRefusal(deps.gate, target.repoKey, target.step);
    if (undecidable !== null) return refusal('not-valid', `the gate of ${shown} cannot be decided now: ${undecidable}`);
    const invalid = checkInputs(args, 'approve');
    if (invalid !== null) return invalid;
    const outcome = await humanApprove(target.repoKey, target.step, target.turnKey, args.inputs);
    const answer = approveAnswer(outcome, shown);
    if (outcome.kind === 'advanced') {
      const entry = deps.entryStatus?.(args.repo);
      if (entry) return { ...answer as object, ...entry, message: `${(answer as { message: string }).message} ${entry.message}` };
    }
    return answer;
  };

  const operations: Record<McpToolName, (args: ActionArguments, caller: McpCaller) => Promise<unknown>> = {
    read_state: () => deps.readState(),
    approve,
    request_changes: (args, caller) => act('request_changes', args, caller),
    redo: (args, caller) => act('redo', args, caller),
    polish: (args, caller) => act('polish', args, caller),
    retry: (args, caller) => act('retry', args, caller),
    dismiss_loop_message: (args, caller) => act('dismiss_loop_message', args, caller),
    choose_flow: (args, caller) => act('choose_flow', args, caller),
    start: (args, caller) => act('start', args, caller),
    terminate: (args, caller) => act('terminate', args, caller),
  };

  return {
    async call(request, caller) {
      if (!isMcpToolName(request.tool)) throw new Error(`no window operation for ${request.tool}`);
      const problem = invalidToolArguments(request.tool, request.args);
      if (problem !== null) return neither('invalid-arguments', problem);
      const args = { ...(request.args as Record<string, unknown> | undefined) };
      if (request.tool === 'approve' && args.turn === null) delete args.turn;
      return operations[request.tool](args as unknown as ActionArguments, caller);
    },
  };
}
