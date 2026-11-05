import type { SliceBrief } from './appLoopState';
import type { WorkCompletion } from './loopDefV2';

/** §28.4.2 — how a loop turn reads the back-to-red brief: as one TDD phase of the reopened slice, or as the loop
 *  at the step the flow returns to, which redoes the whole of the work itself. */
export type SliceBriefReader = { kind: 'phase' } | { kind: 'return-step'; step: string };

/** The brief as a turn receives it, with how that turn reads it. */
export interface SliceBriefDelivery {
  brief: SliceBrief;
  reader: SliceBriefReader;
}

/** How the loop at `step` reads the brief, or null when it never sees it. */
export function sliceBriefReader(completion: WorkCompletion | undefined, step: string, returnStep: string | null): SliceBriefReader | null {
  if (completion !== undefined) return { kind: 'phase' };
  return step === returnStep ? { kind: 'return-step', step } : null;
}

/** Whether approving the loop at `step` ends the brief, because no loop after it reads it. */
export function approveEndsSliceBrief(completion: WorkCompletion | undefined, step: string, returnStep: string | null): boolean {
  return completion === 'refactor' || sliceBriefReader(completion, step, returnStep)?.kind === 'return-step';
}
