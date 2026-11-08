import { isMcpToolName, type McpToolName } from '../shared/mcp';
import type { McpCaller, WindowAnswerFailure, WindowRequest } from '../shared/mcpBridge';
import type { McpWindowState } from '../shared/mcpWindowState';
import type { TurnOrigin } from '../shared/turnOrigin';
import type { GateApproveOutcome } from './appGateDecision';
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
  /** What the window's own Approve control decides with: an MCP approve runs the same human approve over them. */
  gate: HumanApproveDeps & { autoGate: Pick<AutoGate, 'humanDecision'> };
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

/** The window's answer to a tool call, which the server turns into the call's tool result. */
export function createMcpActions(deps: McpActionDeps): { call(request: WindowRequest, caller: McpCaller): Promise<unknown> } {
  const humanApprove = composeHumanApprove(deps.gate.autoGate, deps.gate);

  const approve = async (args: Record<string, string>, caller: McpCaller): Promise<unknown> => {
    if (args.window !== deps.windowId) return refusal('not-this-window', `this session's window is ${quote(deps.windowId)}, not ${quote(args.window)}.`);
    const origin = await deps.originOf(caller);
    if (origin !== 'human') return ORIGIN_REFUSALS[origin];
    const state = deps.readGateState();
    const gate = state.gate;
    if (gate === null || state.repo === null) return refusal('no-gate-waiting', 'the window is not waiting at a gate.');
    const shown = `step ${quote(gate.step)}${gate.turn === null ? '' : `, turn ${quote(gate.turn)}`} of ${quote(state.repo.key)}`;
    if (gate.turn === null) return refusal('not-valid', `the window waits at the step gate of ${shown}, which the flow strip's Advance decides; approve decides a loop gate.`);
    const target: GateTarget = { repoKey: args.repo, step: args.step, turnKey: args.turn };
    if (target.repoKey !== state.repo.key || target.step !== gate.step || target.turnKey !== gate.turn) {
      return refusal('not-valid', `the window waits at the gate of ${shown}, not ${quote(target.step)}, ${quote(target.turnKey)} of ${quote(target.repoKey)}. Read the state again.`);
    }
    if (!gate.options.includes('approve')) return refusal('not-valid', `the gate of ${shown} offers ${gate.options.map(quote).join(', ')}, not approve.`);
    const undecidable = approveRunning(deps.gate.autoGate, target.repoKey, target.step, target.turnKey)
      ? APPROVE_ALREADY_RUNNING
      : humanApproveRefusal(deps.gate, target.repoKey, target.step);
    if (undecidable !== null) return refusal('not-valid', `the gate of ${shown} cannot be decided now: ${undecidable}`);
    return approveAnswer(await humanApprove(target.repoKey, target.step, target.turnKey), shown);
  };

  const operations: Record<McpToolName, (args: Record<string, string>, caller: McpCaller) => Promise<unknown>> = {
    read_state: () => deps.readState(),
    approve,
  };

  return {
    async call(request, caller) {
      if (!isMcpToolName(request.tool)) throw new Error(`no window operation for ${request.tool}`);
      const problem = invalidToolArguments(request.tool, request.args);
      if (problem !== null) return neither('invalid-arguments', problem);
      return operations[request.tool]((request.args ?? {}) as Record<string, string>, caller);
    },
  };
}
