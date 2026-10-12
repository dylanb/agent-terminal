// §B.3 (AC 4) — the gate-decision seam's marked-binding refusal. It is the third of the three seams that must
// yield a human-needed error for a step binding no surviving engine (the view provider and the entry
// dispatcher are the other two). `runAppGateDecision` selects its engine from the persisted run state and
// reads no namespace, and its IPC entry validates payload shape only — so a step that acquires
// `loop_namespace: legacy` while its run state already sits at a verdict would otherwise let `approve` reach
// the OUTWARD-FACING GitHub side effect. The refusal is sited in the composition root's wiring, checked AT the
// operation (CLAUDE.md), never at the renderer control that precedes it.

import { DEFAULT_LOOP_NAMESPACE, MARKED_BINDING_REASON, bindsNoSurvivingEngine, type LoopBinding } from '../shared/loopNamespace';
import type { FlowStepDef } from './flow';
import type { GateDecisionOption } from '../shared/ipc';

/** The loop binding a gate decision for `stepId` acts on, looked up BY ID from the flow's steps — never the
 *  flow's current position (the payload names the step it acts on, §6). A marked step the flow has ADVANCED
 *  past must still be found, or a position-keyed lookup reads the wrong, unmarked step. `null` when `stepId`
 *  is not a loop step (nothing to refuse — the runner handles resolution). */
export function stepLoopBinding(steps: FlowStepDef[], stepId: string): LoopBinding | null {
  const step = steps.find((s) => s.id === stepId);
  return step?.kind === 'loop' ? (step.loopNamespace ?? DEFAULT_LOOP_NAMESPACE) : null;
}

/** §B.3 — the refusal both deciders check at the operation: the reason when `step` binds no surviving engine.
 *  A null (non-loop / unresolved) binding refuses nothing. */
export function markedBindingRefusal(bindingOf: (repoKey: string, step: string) => LoopBinding | null, repoKey: string, step: string): string | null {
  const binding = bindingOf(repoKey, step);
  return binding !== null && bindsNoSurvivingEngine(binding) ? MARKED_BINDING_REASON : null;
}

/** A gate-decision runner (approve one-way, request-changes/redo two-way): resolves to whether the decision
 *  was delivered. */
export type GateDecisionRun = (repoKey: string, step: string, turnKey: string, option: GateDecisionOption, note?: string) => Promise<boolean>;

/** Wrap `run` with §B.3's refusal: when the named step binds no surviving engine, surface the reason and
 *  answer `false` WITHOUT running the decision — so no outward-facing side effect fires for a marked step.
 *  `bindingOf` names the step's binding as a domain concept (the composition root reads it from the loaded
 *  def by id); only a CONFIRMED marked binding refuses, so a null (non-loop / unresolved) defers to `run`. */
export function createGuardedGateDecision(deps: {
  bindingOf: (repoKey: string, step: string) => LoopBinding | null;
  refuse: (reason: string) => void;
  run: GateDecisionRun;
}): GateDecisionRun {
  return (repoKey, step, turnKey, option, note) => {
    const refusal = markedBindingRefusal(deps.bindingOf, repoKey, step);
    if (refusal !== null) {
      deps.refuse(refusal);
      return Promise.resolve(false);
    }
    return deps.run(repoKey, step, turnKey, option, note);
  };
}
