import type { FlowDefinition, FlowStepDef } from './flow';
import { isAdoptPickup, type GateSideEffect, type LoopDefV2, type LoopDefV2Result } from './loopDefV2';
import { GH_ACTION, TICKET_RUN_EFFECTS } from './gateEffects';

const PUBLISH_PR_REVIEW = GH_ACTION.publishPrReview;

interface LoopStep {
  step: FlowStepDef;
  def: LoopDefV2;
}

const effectName = (se: GateSideEffect): string => (se.kind === 'gh' && typeof se.args.action === 'string' ? se.args.action : se.kind);

/** Why a flow with an adopting step must not load, or null when it may. A step whose def does not resolve keeps
 *  its own per-step error and is not judged here. */
export function adoptionLoadProblem(definition: FlowDefinition, resolveDef: (loop: string) => LoopDefV2Result): string | null {
  const loops: LoopStep[] = definition.steps.flatMap((step) => {
    if (step.kind !== 'loop' || step.loop === undefined) return [];
    const resolved = resolveDef(step.loop);
    return resolved.ok ? [{ step, def: resolved.def }] : [];
  });
  const adopting = loops.filter(({ def }) => def.pickup !== null && isAdoptPickup(def.pickup));
  const adopter = adopting[0];
  if (adopter === undefined) return null;
  const a = adopter.step.id;
  const second = adopting[1];
  if (second !== undefined) return `steps ${a} and ${second.step.id} both adopt a pull request; a flow adopts one`;

  const prInputs = definition.steps.flatMap((step) => (step.inputs ?? []).filter((input) => input.type === 'pr').map((input) => ({ step, input })));
  const own = prInputs.find(({ step }) => step === adopter.step);
  if (own === undefined || !own.input.required) return `step ${a} adopts a pull request, so it needs a required pr input naming it`;
  const otherPr = prInputs.find((p) => p !== own);
  if (otherPr !== undefined) {
    return otherPr.step === adopter.step
      ? `step ${a} adopts the PR its pr input ${own.input.name} names, so it cannot declare a second pr input ${otherPr.input.name}`
      : `step ${a} adopts the PR its pr input ${own.input.name} names, so step ${otherPr.step.id} cannot declare the pr input ${otherPr.input.name}`;
  }
  if (adopter.step.gateAuthority === 'auto') return `step ${a} adopts a pull request, so its gate needs a human: it cannot declare gate_authority: auto`;

  for (const { step, def } of loops) {
    if (step !== adopter.step && def.pickup !== null && !isAdoptPickup(def.pickup)) {
      return `step ${a} adopts a pull request, so step ${step.id} cannot pick up a ticket`;
    }
    for (const se of def.gate.flatMap((option) => option.sideEffects)) {
      const effect = effectName(se);
      if (TICKET_RUN_EFFECTS.has(effect)) {
        return step === adopter.step
          ? `step ${a} adopts a pull request, so its gate cannot declare ${effect}`
          : `step ${a} adopts a pull request, so step ${step.id}'s gate cannot declare ${effect}`;
      }
      if (effect !== PUBLISH_PR_REVIEW) continue;
      if (step !== adopter.step) return `${PUBLISH_PR_REVIEW} publishes the PR step ${a} adopts, so step ${step.id}'s gate cannot declare it`;
      if (!def.outputs.some((output) => output.id === se.args.artifact)) {
        return `step ${a}'s ${PUBLISH_PR_REVIEW} artifact ${String(se.args.artifact)} is not one of its outputs`;
      }
    }
  }
  return null;
}
