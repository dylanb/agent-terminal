// #180 — a span of a flow's steps, from `first` to `last` in the definition's step order: the one resolver the
// bench runner's refusals and the app's span guard both decide membership through.

import type { BenchSpan } from './benchLaunch';

export type StepSpanRead =
  | { ok: true; firstIndex: number; lastIndex: number }
  | { ok: false; cause: 'unknown-step' | 'out-of-order' };

export function resolveStepSpan(stepIds: readonly string[], span: BenchSpan): StepSpanRead {
  const firstIndex = stepIds.indexOf(span.first);
  const lastIndex = stepIds.indexOf(span.last);
  if (firstIndex < 0 || lastIndex < 0) return { ok: false, cause: 'unknown-step' };
  if (lastIndex < firstIndex) return { ok: false, cause: 'out-of-order' };
  return { ok: true, firstIndex, lastIndex };
}
