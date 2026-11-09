import type { AppGateDecisionDeps } from './appGateDecision';
import type { FlowManager } from './flow';
import type { RepeatListRecord } from './flowState';
import type { LoopDefV2 } from './loopDefV2';
import { outputLocation } from './appWorkTurn';
import { countToSource, repeatListTitles, type RepeatListSpec } from '../shared/repeatList';

export interface RepeatSourcerDeps {
  flow: FlowManager;
  readArtifact(path: string): string | null;
}

const PLAN_OUTPUT = 'plan';
const PLAN_SLICES: RepeatListSpec = { format: 'impl-slices' };

export function createRepeatSourcer(deps: RepeatSourcerDeps): AppGateDecisionDeps['sourceSliceCount'] {
  const sourced = (repoDir: string, def: LoopDefV2, artifact: string, spec: RepeatListSpec): RepeatListRecord | null => {
    const currentSlice = deps.flow.currentSlice(repoDir);
    const at = outputLocation(def, artifact, currentSlice);
    if (at === null) return null;
    const text = deps.readArtifact(at.path);
    const titles = text === null ? null : repeatListTitles(spec, text);
    const count = titles === null ? null : countToSource(titles.length, currentSlice);
    return titles === null || count === null ? null : { count, titles };
  };
  return (repoDir, def) => {
    const source = deps.flow.repeatSource(repoDir);
    const plan = sourced(repoDir, def, PLAN_OUTPUT, PLAN_SLICES);
    const countFrom = source?.kind === 'list' ? sourced(repoDir, def, source.artifact, source) : null;
    if (plan !== null || countFrom !== null) deps.flow.recordSourcedLists(repoDir, { plan, countFrom });
  };
}
