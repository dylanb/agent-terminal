import type { AppGateDecisionDeps } from './appGateDecision';
import type { FlowManager, FlowStepDef } from './flow';
import type { LoopDefV2 } from './loopDefV2';
import { outputLocation } from './appWorkTurn';
import { countToSource, repeatListTitles, type RepeatListSpec } from '../shared/repeatList';

export interface RepeatSourcerDeps {
  flow: FlowManager;
  /** The artifact at `path`, or null when it cannot be read. */
  readArtifact(path: string): string | null;
  /** The repeat declaration of the run bound in `repoDir`, if its flow has one. */
  repeatOf(repoDir: string): FlowStepDef['repeat'];
}

const PLAN_OUTPUT = 'plan';
const PLAN_SLICES: RepeatListSpec = { format: 'impl-slices' };

/** Re-sources a repeat's count at an approve of a step whose loop outputs its count source (§28.4.1). */
export function createRepeatSourcer(deps: RepeatSourcerDeps): AppGateDecisionDeps['sourceSliceCount'] {
  const sourced = (repoDir: string, def: LoopDefV2, artifact: string, spec: RepeatListSpec): number | null => {
    const currentSlice = deps.flow.currentSlice(repoDir);
    const at = outputLocation(def, artifact, currentSlice);
    if (at === null) return null;
    const text = deps.readArtifact(at.path);
    const titles = text === null ? null : repeatListTitles(spec, text);
    return titles === null ? null : countToSource(titles.length, currentSlice);
  };
  return (repoDir, def) => {
    const slices = sourced(repoDir, def, PLAN_OUTPUT, PLAN_SLICES);
    if (slices !== null) deps.flow.resolveInputs(repoDir, { slices: String(slices) });
    const source = deps.repeatOf(repoDir)?.source;
    if (source?.kind !== 'list') return;
    const count = sourced(repoDir, def, source.artifact, source);
    if (count !== null) deps.flow.sourceRepeatList(repoDir, { count });
  };
}
