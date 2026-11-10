import type { FlowDefinition, FlowStepDef } from './flow';

export type StepOutputIds = (step: FlowStepDef) => readonly string[] | null;

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
