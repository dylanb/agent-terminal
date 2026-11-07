import type { FlowDefinition, FlowStepDef } from './flow';

/** The output ids a loop step's loop declares, or null when its loop does not resolve. */
export type StepOutputIds = (step: FlowStepDef) => readonly string[] | null;

/** §28.4.1 — why a list-form repeat cannot be sourced, naming the repeat step and the artifact no resolved loop
 *  outputs; null when it can be, and for every flow without a list-form repeat. The step id leads, so a display
 *  bound cuts only the flow-supplied artifact id. */
export function countSourceRefusal(definition: FlowDefinition, outputIdsOf: StepOutputIds): string | null {
  const repeatStep = definition.steps.find((s) => s.repeat !== undefined);
  const source = repeatStep?.repeat?.source;
  if (repeatStep === undefined || source === undefined || source.kind !== 'list') return null;
  let unresolved = false;
  for (const step of definition.steps) {
    if (step.loop === undefined) continue;
    const outputs = outputIdsOf(step);
    if (outputs === null) unresolved = true;
    else if (outputs.includes(source.artifact)) return null;
  }
  const why = unresolved ? ' (a step\'s loop did not resolve)' : '';
  return `step ${repeatStep.id}: repeat.count_from.artifact "${source.artifact}" is not an output of any step's loop${why}`;
}
