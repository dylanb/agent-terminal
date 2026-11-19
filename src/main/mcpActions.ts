import type { FlowInputValidation } from './flow';
import { mcpTodo } from '../shared/mcpWindowState';
import { outstandingTodoOrder } from '../shared/todoOrder';
import type { TodoStore } from './todoStore';
import type { MonitorEvent } from '../shared/ipc';
import { type McpToolName } from '../shared/mcp';
import type { McpCaller, WindowAnswerFailure } from '../shared/mcpBridge';
import type { McpWindowState } from '../shared/mcpWindowState';
import type { TurnOrigin } from '../shared/turnOrigin';
import type { GateApproveOutcome } from './appGateDecision';
import type { AppRetryOutcome } from './appLoopEngine';
import type { McpGateOperations, GateTarget } from './mcpGateOperations';
import { type McpCommand, type CommandFor } from './mcpTools';
import type { McpActionResult, McpOperationResult } from './mcpActionResult';

export interface McpActionDeps {
  todos: Pick<TodoStore, 'list' | 'add' | 'update' | 'reorder' | 'setStatus' | 'delete'>;
  captureReport: () => MonitorEvent[];
  sendTodo: (caller: McpCaller, repo: string, todo: { id: string; text: string }) => string | null;
  windowId: string;
  readState(): Promise<McpWindowState>;
  readActionState: () => McpWindowState;
  entryStatus: (repo: string) => McpOperationResult | null;
  gate: McpGateOperations;
  retry: (repo: string, step: string, turn: string) => AppRetryOutcome;
  dismissLoopMessage: (id: string) => void;
  chooseFlow: (repo: string, id: string) => { ok: boolean; reason?: string };
  validateEntryInputs: (repo: string, action: 'start' | 'approve', values: Record<string, string>) => FlowInputValidation;
  start: (repo: string, inputs: Record<string, string>) => McpOperationResult;
  terminate: (repo: string) => McpOperationResult;
  advance: (repo: string, step: string, inputs: Record<string, string>) => McpOperationResult;
}

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

function approveAnswer(outcome: GateApproveOutcome, at: string): McpOperationResult {
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

type TodoTool = Extract<McpToolName, `todo_${string}` | 'capture_report'>;

export function createMcpActions(deps: McpActionDeps): { execute(command: McpCommand, caller: McpCaller, origin: TurnOrigin): Promise<McpActionResult> } {


  const checkInputs = (args: { repo: string; inputs?: Record<string, string> }, action: 'start' | 'approve'): WindowAnswerFailure | null => {
    const result = deps.validateEntryInputs(args.repo, action, args.inputs ?? {});
    return result.valid ? null : refusal('not-valid', result.reason);
  };
  const act = async (command: Exclude<McpCommand, CommandFor<'read_state' | 'approve' | TodoTool>>, origin: TurnOrigin): Promise<McpActionResult> => {
    const { args, tool } = command;
    if (args.window !== deps.windowId) return refusal('not-this-window', `this session's window is ${quote(deps.windowId)}.`);
    if (origin !== 'human') return ORIGIN_REFUSALS[origin];
    const state = deps.readActionState();
    const decidesGate = tool === 'request_changes' || tool === 'redo' || tool === 'polish';
    if (decidesGate && state.gate === null) return refusal('no-gate-waiting', 'the window is not waiting at a gate.');
    if (state.repo?.key !== args.repo) return refusal('not-valid', `the current repository is ${quote(state.repo?.key ?? 'none')}. Read the state again.`);
    switch (command.tool) {
      case 'request_changes':
      case 'redo':
      case 'polish': {
        const { args, tool } = command;
        const gate = state.gate!;
        const option = tool === 'request_changes' ? 'request-changes' : tool;
        if (gate.turn === null || gate.step !== args.step || gate.turn !== args.turn || !gate.options.includes(option)) return refusal('not-valid', `the current gate is ${quote(gate.step)}, turn ${quote(gate.turn ?? 'none')}, offering ${gate.options.join(', ')}.`);
        const target = { repoKey: args.repo, step: args.step, turnKey: args.turn ?? '' };
        const held = deps.gate.refusal(target);
        if (held !== null) return refusal('not-valid', held);
        const note = command.tool === 'request_changes' ? command.args.feedback : command.tool === 'redo' ? command.args.instruction : undefined;
        if (tool !== 'polish' && !note?.trim()) return refusal('not-valid', 'provide nonblank feedback or an instruction.');
        const outcome = await deps.gate.decide(target, option, note);
        return outcome.taken ? { kind: 'taken', message: `${tool} taken at ${quote(args.step)}.` }
          : neither('not-taken', outcome.reason);
      }
      case 'retry': {
        const { args } = command;
        { const held = deps.gate.pickupHold(args.repo); if (held !== null) return refusal('not-valid', held); }
        if (!state.stalledTurn || state.stalledTurn.step !== args.step || state.stalledTurn.turn !== args.turn) return refusal('not-valid', 'the stopped turn no longer matches; read the state again.');
        { const outcome = deps.retry(args.repo, args.step, args.turn);
          return outcome.taken ? { kind: 'retried', message: 'The stopped turn was retried.' }
            : neither('not-taken', outcome.reason); }
      }
      case 'dismiss_loop_message': {
        const { args } = command;
        if (state.loopMessage?.id !== args.message) return refusal('not-valid', 'the message no longer matches; read the state again.');
        deps.dismissLoopMessage(args.message);
        return { kind: 'dismissed', message: 'The loop message was dismissed.' };
      }
      case 'choose_flow': {
        const { args } = command;
        if (state.flow?.runStarted || !state.startable?.some(item => item.id === args.flow)) return refusal('not-valid', 'choose an available flow before a run starts.');
        { const result = deps.chooseFlow(args.repo, args.flow);
          return result.ok ? { kind: 'selected', message: `Selected ${quote(args.flow)}.` } : refusal('not-valid', result.reason ?? 'the flow could not be selected.'); }
      }
      case 'start': {
        const { args } = command;
        if (state.flow?.runStarted || state.selectionUnusable) return refusal('not-valid', 'the selected flow cannot start in this state.');
        const invalid = checkInputs(args, 'start');
        return invalid ?? deps.start(args.repo, args.inputs ?? {});
      }
      case 'terminate': {
        const { args } = command;
        if (state.terminateTodoCount === null || state.terminateTodoCount !== args.expectedTodoCount) return refusal('not-valid', `the current termination todo count is ${state.terminateTodoCount ?? 'unavailable'}. Read the state again.`);
        return deps.terminate(args.repo);
      }
      default:
        return command satisfies never;
    }
  };

  const approve = async (args: CommandFor<'approve'>['args'], origin: TurnOrigin): Promise<McpActionResult> => {
    if (args.window !== deps.windowId) return refusal('not-this-window', `this session's window is ${quote(deps.windowId)}, not ${quote(args.window)}.`);
    if (origin !== 'human') return ORIGIN_REFUSALS[origin];
    const state = deps.readActionState();
    const gate = state.gate;
    if (gate === null || state.repo === null) return refusal('no-gate-waiting', 'the window is not waiting at a gate.');
    const shown = `step ${quote(gate.step)}${gate.turn === null ? '' : `, turn ${quote(gate.turn)}`} of ${quote(state.repo.key)}`;
    if (gate.turn === null) {
      if (args.repo !== state.repo.key || args.step !== gate.step || (args.turn !== undefined && args.turn !== null)) return refusal('not-valid', `the window waits at ${shown}. Read the state again.`);
      const held = deps.gate.pickupHold(args.repo);
      if (held !== null) return refusal('not-valid', held);
      const invalid = checkInputs(args, 'approve');
      if (invalid !== null) return invalid;
      const outcome = deps.advance(args.repo, args.step, args.inputs ?? {});
      const outstanding = (await deps.readState()).todos.some(todo => todo.status !== 'done');
      return outstanding ? { ...outcome, message: `${outcome.message ?? 'Advanced.'} Todos are still outstanding.` } : outcome;
    }
    const target: GateTarget = { repoKey: args.repo, step: args.step, turnKey: args.turn ?? '' };
    if (target.repoKey !== state.repo.key || target.step !== gate.step || target.turnKey !== gate.turn) {
      return refusal('not-valid', `the window waits at the gate of ${shown}, not ${quote(target.step)}, ${quote(target.turnKey)} of ${quote(target.repoKey)}. Read the state again.`);
    }
    if (!gate.options.includes('approve')) return refusal('not-valid', `the gate of ${shown} offers ${gate.options.map(quote).join(', ')}, not approve.`);
    const undecidable = deps.gate.refusal(target);
    if (undecidable !== null) return refusal('not-valid', `the gate of ${shown} cannot be decided now: ${undecidable}`);
    const invalid = checkInputs(args, 'approve');
    if (invalid !== null) return invalid;
    const outcome = await deps.gate.approve(target, args.inputs);
    const answer = approveAnswer(outcome, shown);
    if (outcome.kind === 'advanced') {
      const entry = deps.entryStatus(args.repo);
      if (entry) return { ...answer, ...entry, message: `${answer.message} ${entry.message}` };
    }
    return answer;
  };

  const todo = async (command: CommandFor<TodoTool>, caller: McpCaller, origin: TurnOrigin): Promise<McpActionResult> => {
    const { args, tool } = command;
    if (args.window !== deps.windowId) return refusal('not-this-window', `this session's window is ${quote(deps.windowId)}.`);
    if (tool === 'todo_send') {
      if (origin !== 'human') return ORIGIN_REFUSALS[origin];
    }
    const state = deps.readActionState();
    if (state.repo?.key !== args.repo) return refusal('not-valid', 'the repository changed; read the state again.');
    if (tool === 'capture_report') {
      const events = deps.captureReport();
      return { kind: 'captured', message: events.length ? 'Captured the latest report.' : 'No report detected; the prior capture is preserved.', events };
    }
    const store = deps.todos;
    const items = store.list(args.repo);
    const targets = command.tool === 'todo_reorder' ? command.args.todos : command.tool === 'todo_create' ? [] : [command.args.todo];
    if (targets.some(id => !items.some(item => item.id === id))) return refusal('not-valid', 'a todo no longer exists; read the state again.');
    if (['todo_edit', 'todo_reorder', 'todo_send'].includes(tool) && targets.some(id => items.some(item => item.id === id && item.status === 'done'))) return refusal('not-valid', 'a completed todo cannot be edited, reordered or sent.');
    switch (command.tool) {
      case 'todo_create':
        if (!command.args.text.trim()) return refusal('not-valid', 'provide nonblank todo text.');
        return { kind: 'created', todos: store.add(command.args.repo, command.args.text).map(mcpTodo) };
      case 'todo_edit':
        if (!command.args.text.trim()) return refusal('not-valid', 'provide nonblank todo text.');
        return { kind: 'edited', todos: store.update(command.args.repo, command.args.todo, command.args.text).map(mcpTodo) };
      case 'todo_complete': return { kind: 'completed', todos: store.setStatus(command.args.repo, command.args.todo, 'done').map(mcpTodo) };
      case 'todo_delete': return { kind: 'deleted', todos: store.delete(command.args.repo, command.args.todo).map(mcpTodo) };
      case 'todo_reorder':
        if (command.args.todos.length !== items.filter(item => item.status !== 'done').length || new Set(command.args.todos).size !== command.args.todos.length) return refusal('not-valid', 'provide every outstanding todo exactly once.');
        return { kind: 'reordered', todos: store.reorder(command.args.repo, outstandingTodoOrder(items, command.args.todos)).map(mcpTodo) };
      case 'todo_send': {
        const item = items.find(item => item.id === command.args.todo)!;
        if (typeof item.text !== 'string' || !item.text.trim()) return refusal('not-valid', 'the stored todo text is malformed or blank; edit it before sending.');
        const reason = deps.sendTodo(caller, command.args.repo, { id: item.id, text: item.text });
        if (reason !== null) return refusal('not-valid', reason);
        return { kind: 'accepted', message: 'Accepted for delivery when this turn ends and the session is idle.' };
      }
      default: return command satisfies never;
    }
  };

  return {
    async execute(command, caller, origin) {
      switch (command.tool) {
        case 'read_state': return deps.readState();
        case 'approve': return approve(command.args, origin);
        case 'todo_create': case 'todo_edit': case 'todo_reorder': case 'todo_complete':
        case 'todo_delete': case 'todo_send': case 'capture_report': return todo(command, caller, origin);
        case 'request_changes': case 'redo': case 'polish': case 'retry':
        case 'dismiss_loop_message': case 'choose_flow': case 'start': case 'terminate': return act(command, origin);
        default: return command satisfies never;
      }
    },
  };
}
