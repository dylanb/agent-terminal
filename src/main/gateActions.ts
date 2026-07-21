// App-internal gate transition (§26.6 / L5 / D52). When the human picks a gate option, the app — not an
// injected `/agent-loop-*` command (retired, §26.12) — executes that option's `on_*` action list from the
// bound LoopDef. `decideGateOutcome` is the pure core: it translates the raw GateAction list + the gate's
// next_status_on_* into the normalized outcome the orchestrator carries out (write status, run the gh
// side-effects out of band, re-iterate or stop). `epic-promote` (§26.9 / L8) and `exec` (§26.6 — the
// ADR-0015 ticket-body publish, run best-effort under the loops_deny_exec opt-out) ARE modeled. Action
// kinds the in-app v1 engine still does not model are dropped — `publish-body` (spec §26 out-of-band
// PR-body publish, deferred) and `reset-severity-cycle` (in the vendored defs it only ever accompanies
// `terminate`, where it is moot). The full deferred set is recorded in-spec.

import type { GateAction, LoopGate } from './loopDef';
import type { GateDecisionOption } from '../shared/ipc';

/** The gate option this pure core decides on — the §6 wire type, so the decision core, the validator, and
 *  the renderer button set share one definition (CLAUDE.md shared-semantics). */
export type GateOption = GateDecisionOption;

/** A modeled gate side-effect the orchestrator carries out (`gateExecutor.executeGateOutcome`). Every
 *  member here is consumed there; action kinds outside this set are dropped by `decideGateOutcome`. */
export type GateEffect =
  | { kind: 'mark-pr-ready' }
  // §26.6/§26.8 — request-changes resets the per-loop iteration-cap window; the executor writes
  // cap_baseline = the critiqued iteration.
  | { kind: 'reset-cap' }
  | { kind: 'clear-persona-state' }
  | { kind: 'append-human-note' }
  | { kind: 'epic-promote' }
  // §26.6 — the ADR-0015 adapter side-effect (e.g. plan-approve ticket-body publish). `argv` carries the
  // def's command with its `{{…}}` placeholders unresolved; the executor interpolates + runs it out of band
  // (best-effort), gated on the repo's opt-out (loops_deny_exec). A kind-less/argv-less entry is dropped.
  | { kind: 'exec'; argv: string[] }
  | { kind: 'terminate' };

export interface GateOutcome {
  /** The gate's `next_status_on_<option>` — the status the app writes to state.yaml. */
  nextStatus: string;
  /** The run ends here: an explicit `terminate` action, or the impasse option (impasse is terminal, §26.8). */
  terminate: boolean;
  /** request-changes routes back to a fresh work turn at the entry status (the engine's re-iterate). */
  reiterate: boolean;
  /** The recognized side-effects, in the action list's order. */
  effects: GateEffect[];
}

function actionsFor(gate: LoopGate, option: GateOption): { actions: GateAction[]; nextStatus: string } {
  switch (option) {
    case 'approve':
      return { actions: gate.onApprove, nextStatus: gate.nextStatusOnApprove };
    case 'request-changes':
      return { actions: gate.onRequestChanges, nextStatus: gate.nextStatusOnRequestChanges };
    case 'impasse':
      return { actions: gate.onImpasse, nextStatus: gate.nextStatusOnImpasse };
    // §27.9/§27.15 (AC8) — redo/polish are §27-only options that widen the shared GATE_DECISION_OPTIONS set;
    // the §26 executor never runs them (the §26 gate handler rejects an option its def does not declare), so if
    // one reaches here it is inert: no §26 action and no status change (gate.id is the current status). Named
    // explicitly (not a `default:`) so the `never` guard below keeps this switch exhaustive over the shared set:
    // a future option added to GATE_DECISION_OPTIONS must be consciously handled here rather than silently inert.
    case 'redo':
    case 'polish':
      return { actions: [], nextStatus: gate.id };
    default: {
      const unhandled: never = option;
      return unhandled;
    }
  }
}

/** Translate one raw GateAction to a modeled effect, or null when the kind is outside the v1 set. */
function toEffect(a: GateAction): GateEffect | null {
  switch (a.kind) {
    case 'mark-pr-ready':
      return { kind: 'mark-pr-ready' };
    case 'reset-cap':
      return { kind: 'reset-cap' };
    case 'clear-persona-state':
      return { kind: 'clear-persona-state' };
    case 'append-human-note':
      return { kind: 'append-human-note' };
    // §26.9 / L8 — the `when: plan.classification == 'epic'` guard is evaluated at execution time
    // (gateExecutor reads the epic plan); the effect itself is always recognized in the action list.
    case 'epic-promote':
      return { kind: 'epic-promote' };
    // §26.6 — carry the exec argv through only when it is a string[]; a malformed/absent argv drops the
    // action (never surface an exec effect with nothing to run).
    case 'exec': {
      const argv = a.args?.argv;
      return Array.isArray(argv) && argv.every((x): x is string => typeof x === 'string')
        ? { kind: 'exec', argv }
        : null;
    }
    case 'terminate':
      return { kind: 'terminate' };
    default:
      return null;
  }
}

/** Decide the transition a gate option performs (§26.6). Pure: reads only the gate + option. */
export function decideGateOutcome(gate: LoopGate, option: GateOption): GateOutcome {
  const { actions, nextStatus } = actionsFor(gate, option);
  const effects = actions.map(toEffect).filter((e): e is GateEffect => e !== null);
  // §26.8 — impasse is a terminal status even when its action list is only a human-note; an explicit
  // `terminate` action ends approve. request-changes is the only re-iterating option.
  const terminate = option === 'impasse' || effects.some((e) => e.kind === 'terminate');
  const reiterate = option === 'request-changes' && !terminate;
  return { nextStatus, terminate, reiterate, effects };
}

/** §26 D42a — whether this gate decision reaches a SUCCESS terminal, the signal to auto-advance the
 *  enclosing flow to its next step. A success terminal is an `approve` whose action list terminates the
 *  loop; impasse also terminates but is a human-owned FAILURE terminal (no advance), request-changes
 *  re-iterates, and an `approve` at an intermediate gate (advancing a phase WITHIN the loop) is not
 *  terminal — none of those advance the flow. */
export function shouldAdvanceFlowOnGate(option: GateOption, outcome: GateOutcome): boolean {
  return option === 'approve' && outcome.terminate;
}
