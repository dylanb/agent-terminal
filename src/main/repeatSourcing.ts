import type { AppGateDecisionDeps } from './appGateDecision';
import type { FlowManager, FlowStepDef } from './flow';
import type { RepeatListRecord } from './flowState';
import type { LoopDefV2 } from './loopDefV2';
import { outputLocation } from './appWorkTurn';
import { countToSource, repeatListTitles, type RepeatListSpec } from '../shared/repeatList';

export interface RepeatSourcerDeps {
  flow: FlowManager;
  readArtifact(path: string): string | null;
  /** The repeat declaration of the run bound in `repoDir`, if its flow has one. */
  repeatOf(repoDir: string): FlowStepDef['repeat'];
}

/** Whether a read follows a symlink at the output's own name. */
type LeafLink = 'follow' | 'refuse';

const PLAN_OUTPUT = 'plan';
const PLAN_SLICES: RepeatListSpec = { format: 'impl-slices' };
const PLAN_SLICES_INPUT = 'slices';

/** Re-sources a repeat's count at an approve of a step whose loop outputs its count source (§28.4.1). */
export function createRepeatSourcer(deps: RepeatSourcerDeps): AppGateDecisionDeps['sourceSliceCount'] {
  const sourced = (repoDir: string, def: LoopDefV2, artifact: string, spec: RepeatListSpec, leaf: LeafLink): RepeatListRecord | null => {
    const currentSlice = deps.flow.currentSlice(repoDir);
    const at = outputLocation(def, artifact, currentSlice);
    if (at === null) return null;
    const file = leaf === 'follow' ? at.path : at.leafPath;
    const text = file === null ? null : deps.readArtifact(file);
    const titles = text === null ? null : repeatListTitles(spec, text);
    const count = titles === null ? null : countToSource(titles.length, currentSlice);
    return titles === null || count === null ? null : { count, titles };
  };
  return (repoDir, def) => {
    const source = deps.repeatOf(repoDir)?.source;
    const planIsListSource = source?.kind === 'list' && source.artifact === PLAN_OUTPUT;
    const plan = sourced(repoDir, def, PLAN_OUTPUT, PLAN_SLICES, planIsListSource ? 'refuse' : 'follow');
    if (plan !== null) {
      const inputs = { [PLAN_SLICES_INPUT]: String(plan.count) };
      if (source?.kind === 'input' && source.countInput === PLAN_SLICES_INPUT) deps.flow.sourceRepeatList(repoDir, { ...plan, inputs });
      else deps.flow.resolveInputs(repoDir, inputs);
    }
    if (source?.kind !== 'list') return;
    const list = sourced(repoDir, def, source.artifact, source, 'refuse');
    if (list !== null) deps.flow.sourceRepeatList(repoDir, list);
  };
}
