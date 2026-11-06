import type { AppGateDecisionDeps } from './appGateDecision';
import type { FlowManager, FlowStepDef } from './flow';

export interface RepeatSourcerDeps {
  flow: FlowManager;
  /** The artifact at `path`, or null when it cannot be read. */
  readArtifact(path: string): string | null;
  /** The repeat declaration of the run bound in `repoDir`, if its flow has one. */
  repeatOf(repoDir: string): FlowStepDef['repeat'];
}

/** Re-sources a repeat's count at an approve of a step whose loop outputs its count source (§28.4.1). */
export function createRepeatSourcer(_deps: RepeatSourcerDeps): AppGateDecisionDeps['sourceSliceCount'] {
  return () => {};
}
