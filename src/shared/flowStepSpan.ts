// §18.7.8

export interface StepSpan {
  first: string;
  last: string;
}

export type StepSpanRead =
  | { ok: true; firstIndex: number; lastIndex: number }
  | { ok: false; cause: 'unknown-step' | 'out-of-order' };

export function resolveStepSpan(stepIds: readonly string[], span: StepSpan): StepSpanRead {
  const firstIndex = stepIds.indexOf(span.first);
  const lastIndex = stepIds.indexOf(span.last);
  if (firstIndex < 0 || lastIndex < 0) return { ok: false, cause: 'unknown-step' };
  if (lastIndex < firstIndex) return { ok: false, cause: 'out-of-order' };
  return { ok: true, firstIndex, lastIndex };
}
