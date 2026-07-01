// App-internal gate transition (§26.6 / L5 / D52). When the human picks a gate option, the app — not an
// injected `/agent-loop-*` command (retired, §26.12) — executes that option's `on_*` action list from the
// bound LoopDef. `decideGateOutcome` is the pure core: it translates the raw GateAction list + the gate's
// next_status_on_* into the normalized outcome the orchestrator carries out (write status, run the gh
// side-effects out of band, re-iterate or stop). Unknown action kinds are dropped — the orchestrator only
// acts on the effects it models (epic-promote lands in L8, §26.9; `exec` is still parsed-then-dropped).

import type { GateAction, LoopGate } from './loopDef';

export type GateOption = 'approve' | 'request-changes' | 'impasse';

/** A recognized gate side-effect the orchestrator knows how to perform. Kinds outside this set are
 *  dropped by `decideGateOutcome` (v1 does not model epic-promote/exec — §26.9, later slices). */
export type GateEffect =
  | { kind: 'mark-pr-ready' }
  | { kind: 'set-phase2'; active: boolean }
  | { kind: 'clear-persona-state' }
  | { kind: 'append-human-note' }
  | { kind: 'clear-phase2' }
  | { kind: 'reset-severity-cycle' }
  | { kind: 'epic-promote' }
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
  }
}

/** Translate one raw GateAction to a modeled effect, or null when the kind is outside the v1 set. */
function toEffect(a: GateAction): GateEffect | null {
  switch (a.kind) {
    case 'mark-pr-ready':
      return { kind: 'mark-pr-ready' };
    case 'set-phase2':
      return { kind: 'set-phase2', active: a.args?.active === true };
    case 'clear-persona-state':
      return { kind: 'clear-persona-state' };
    case 'append-human-note':
      return { kind: 'append-human-note' };
    case 'clear-phase2':
      return { kind: 'clear-phase2' };
    case 'reset-severity-cycle':
      return { kind: 'reset-severity-cycle' };
    // §26.9 / L8 — the `when: plan.classification == 'epic'` guard is evaluated at execution time
    // (gateExecutor reads the epic plan); the effect itself is always recognized in the action list.
    case 'epic-promote':
      return { kind: 'epic-promote' };
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
