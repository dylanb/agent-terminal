// Known-good flow and loop definitions built one position at a time, for the engine-capabilities conformance
// tests. Every key the oracle lists at a position has one sample value here, so adding a key to the
// oracle fails typecheck until it has one, and a position's samples load together as one definition. Definitions
// load through the real loaders from temp directories.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { loadFlowDefinitionFromFile, type FlowLoad } from '../../src/main/flow';
import { resolveLoopDefV2, type LoopDefV2Context, type LoopDefV2Result } from '../../src/main/loopDefV2';
import {
  LOOP_LAYOUT,
  ONE_OF_KEYS,
  POSITIONS,
  positionKeys,
  type ClosedSet,
  type ClosedValue,
  type FlowKeyOf,
  type FlowPositionId,
  type LoopKeyOf,
  type LoopPositionId,
  type PositionId,
  type TierId,
} from './engineCapabilityOracle';

type Doc = Record<string, unknown>;

export const SAMPLE_FLOW = 'sample-flow';
export const SAMPLE_LOOP = 'sample-loop';
const EARLIER_STEP = { id: 'first', kind: 'manual' };

export const FLOW_SAMPLES: { [P in FlowPositionId]: Record<FlowKeyOf<P>, unknown> } = {
  flow: { name: SAMPLE_FLOW, steps: [EARLIER_STEP] },
  'flow.steps[]': {
    id: 'second',
    kind: 'loop',
    loop: 'plan-loop',
    gate_authority: 'human',
    loop_namespace: 'app',
    skill: 'groom-ticket',
    todo_template: 'ticket-grooming',
    bootstrap: 'pickup',
    inputs: [{ name: 'ticket', type: 'github-ticket', required: true }],
    repeat: { back_to: EARLIER_STEP.id, count_input: 'slices' },
  },
  'flow.steps[].inputs[]': { name: 'ticket', type: 'github-ticket', required: true },
  'flow.steps[].repeat': { back_to: EARLIER_STEP.id, count_input: 'slices', count_from: { artifact: 'steps', format: 'json-list', list: 'steps' } },
  'flow.steps[].repeat.count_from': { artifact: 'steps', format: 'json-list', list: 'steps' },
};

const RECIPE = 'recipe.md';
const CHARTER = 'charter.md';
const BRIEF = 'brief.md';
const CONSOLIDATE = 'consolidate.md';
const PLAN_OUTPUT = { id: 'plan', path: 'plan.md' };

/** `value` with an unexpanded `{…}` slot in it; a reference file of that name is planted beside each definition. */
export const withSlot = (value: string): string => `{slot}-${value}`;

export const LOOP_SAMPLES: { [P in LoopPositionId]: Record<LoopKeyOf<P>, unknown> } = {
  loop: {
    version: 'v2',
    name: SAMPLE_LOOP,
    brief: BRIEF,
    work: { recipe: RECIPE, artifact: PLAN_OUTPUT.id },
    reviewers: [],
    consolidator: { recipe: CONSOLIDATE },
    report: { sections: ['summary'] },
    gate: [{ option: 'approve' }],
    exec: { program: 'echo' },
    outputs: [PLAN_OUTPUT],
    boundaries: [{ boundary: 'pre-work', mode: 'clear' }],
    pickup: { initial_status: 'planning', branch_template: 'work/issue-{issue}' },
    inputs: [{ id: 'ticket', path: 'groomed-ticket.md' }],
  },
  'loop.work': {
    recipe: RECIPE,
    artifact: PLAN_OUTPUT.id,
    completion: 'red',
    frozen_check: true,
    goal: 'the plan is reviewed clean',
    checkpoint: { passes: 3 },
  },
  'loop.work.checkpoint': { passes: 3 },
  'loop.reviewers[]': { persona: 'review-principal', charter: CHARTER, tools: ['Read', 'Grep'] },
  'loop.consolidator': { recipe: CONSOLIDATE },
  'loop.boundaries[]': { boundary: 'pre-work', mode: 'compact', message: 'Keep the plan.' },
  'loop.report': { sections: ['summary'], polish: 'defer' },
  'loop.gate[]': { option: 'approve', side_effects: [{ kind: 'gh', action: 'mark-ready' }] },
  'loop.gate[].side_effects[]': { kind: 'gh' },
  'loop.pickup': {
    initial_status: 'planning',
    branch_template: 'work/issue-{issue}',
    initial_labels: [{ action: 'add', target: 'issue', label: 'in-progress' }],
    on_conflict: 'abort',
  },
  'loop.pickup.initial_labels[]': { action: 'add', target: 'issue', label: 'in-progress' },
  'loop.inputs[]/outputs[]': { id: PLAN_OUTPUT.id, path: PLAN_OUTPUT.path, sections_dir: 'plan-sections' },
  'loop.exec': { program: 'echo' },
};

/** What a definition built from only a position's always-required keys sets instead of the sample, where the sample
 *  would make a conditional key required (a loop step needs `loop`; a compact boundary needs `message`). */
export const FLOW_REQUIRED_ONLY_VALUES: { [P in FlowPositionId]?: Partial<Record<FlowKeyOf<P>, unknown>> } = {
  'flow.steps[]': { kind: 'manual' },
  'flow.steps[].repeat.count_from': { format: 'impl-slices' },
};

export const LOOP_REQUIRED_ONLY_VALUES: { [P in LoopPositionId]?: Partial<Record<LoopKeyOf<P>, unknown>> } = {
  'loop.boundaries[]': { mode: 'clear' },
};

function pick(samples: Record<string, unknown>, keys: readonly string[], values: Record<string, unknown> = {}): Doc {
  return Object.fromEntries(keys.map((k) => [k, k in values ? values[k] : samples[k]]));
}

export function flowFields<P extends FlowPositionId>(p: P, keys: readonly FlowKeyOf<P>[], values?: Partial<Record<FlowKeyOf<P>, unknown>>): Doc {
  return pick(FLOW_SAMPLES[p], keys, values);
}

export function loopFields<P extends LoopPositionId>(p: P, keys: readonly LoopKeyOf<P>[], values?: Partial<Record<LoopKeyOf<P>, unknown>>): Doc {
  return pick(LOOP_SAMPLES[p], keys, values);
}

/** A whole flow definition with `fields` at position `p`, every other position at its required keys. */
export function flowWith(p: FlowPositionId, fields: Doc): Doc {
  const step = (extra: Doc): Doc => ({ name: SAMPLE_FLOW, steps: [EARLIER_STEP, { id: 'second', kind: 'manual', ...extra }] });
  switch (p) {
    case 'flow':
      return fields;
    case 'flow.steps[]':
      return { name: SAMPLE_FLOW, steps: [EARLIER_STEP, fields] };
    case 'flow.steps[].inputs[]':
      return step({ inputs: [fields] });
    case 'flow.steps[].repeat':
      return step({ repeat: fields });
    case 'flow.steps[].repeat.count_from':
      return step({ repeat: { back_to: EARLIER_STEP.id, count_from: fields } });
    default:
      return p satisfies never;
  }
}

export const LOOP_BASE: Doc = {
  version: 'v2',
  work: { recipe: RECIPE, artifact: PLAN_OUTPUT.id },
  reviewers: [],
  report: { sections: ['summary'] },
  gate: [],
  boundaries: [],
  outputs: [PLAN_OUTPUT],
};

/** A whole loop definition with `fields` at position `p`, every other position at a valid base. */
export function loopWith(p: LoopPositionId, fields: Doc): Doc {
  switch (p) {
    case 'loop':
      return fields;
    case 'loop.work':
      return { ...LOOP_BASE, work: fields };
    case 'loop.work.checkpoint':
      return { ...LOOP_BASE, work: { recipe: RECIPE, artifact: PLAN_OUTPUT.id, goal: 'the plan is reviewed clean', checkpoint: fields } };
    case 'loop.reviewers[]':
      return { ...LOOP_BASE, reviewers: [fields], consolidator: { recipe: CONSOLIDATE } };
    case 'loop.consolidator':
      return { ...LOOP_BASE, consolidator: fields };
    case 'loop.boundaries[]':
      return { ...LOOP_BASE, boundaries: [fields] };
    case 'loop.report':
      return { ...LOOP_BASE, report: fields };
    case 'loop.gate[]':
      return { ...LOOP_BASE, gate: [fields] };
    case 'loop.gate[].side_effects[]':
      return { ...LOOP_BASE, gate: [{ option: 'approve', side_effects: [fields] }] };
    case 'loop.pickup':
      return { ...LOOP_BASE, pickup: fields };
    case 'loop.pickup.initial_labels[]':
      return { ...LOOP_BASE, pickup: { initial_status: 'planning', branch_template: 'work/issue-{issue}', initial_labels: [fields] } };
    case 'loop.inputs[]/outputs[]':
      return { ...LOOP_BASE, inputs: [fields], outputs: [fields] };
    case 'loop.exec':
      return { ...LOOP_BASE, exec: fields };
    default:
      return p satisfies never;
  }
}

function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
}

export function loadFlowDoc(doc: Doc): FlowLoad {
  const dir = tempDir('capability-flow-');
  try {
    const file = path.join(dir, 'flow.yaml');
    writeFileSync(file, yaml.dump(doc));
    return loadFlowDefinitionFromFile(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Writes a loop definition and the files its references name, so a reference resolves wherever it is placed. */
function plantLoopDef(defFile: string, doc: Doc): void {
  const defDir = path.dirname(defFile);
  mkdirSync(defDir, { recursive: true });
  for (const ref of [RECIPE, CHARTER, BRIEF, CONSOLIDATE].flatMap((r) => [r, withSlot(r)])) writeFileSync(path.join(defDir, ref), `${ref}\n`);
  writeFileSync(defFile, yaml.dump(doc));
}

export function loadLoopDoc(doc: Doc): LoopDefV2Result {
  const appBundled = tempDir('capability-loop-tier-');
  const repoDir = tempDir('capability-loop-repo-');
  try {
    plantLoopDef(path.join(appBundled, LOOP_LAYOUT.defRelPath(SAMPLE_LOOP)), doc);
    return resolveLoopDefV2(SAMPLE_LOOP, { tiers: { operator: null, appBundled, retired: null }, repoDir });
  } finally {
    rmSync(appBundled, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  }
}

/** Sample keys a closed-set value makes illegal at its position: a manual step cannot carry `gate_authority`. */
const DROPPED_BY_VALUE: readonly { set: Pick<ClosedSet, 'position' | 'key'>; value: ClosedValue; drop: readonly string[] }[] = [
  { set: { position: 'flow.steps[]', key: 'kind' }, value: 'manual', drop: ['gate_authority'] },
  { set: { position: 'flow.steps[].repeat.count_from', key: 'format' }, value: 'impl-slices', drop: ['list'] },
];

/** The sample value of every key the oracle lists at position `p`. */
export function samplesAt(p: PositionId): Readonly<Record<string, unknown>> {
  return POSITIONS[p].definition === 'flow' ? FLOW_SAMPLES[p as FlowPositionId] : LOOP_SAMPLES[p as LoopPositionId];
}

/** What a definition of only position `p`'s always-required keys sets instead of the sample. */
export function requiredOnlyValuesAt(p: PositionId): Readonly<Record<string, unknown>> {
  return (POSITIONS[p].definition === 'flow' ? FLOW_REQUIRED_ONLY_VALUES[p as FlowPositionId] : LOOP_REQUIRED_ONLY_VALUES[p as LoopPositionId]) ?? {};
}

/** Position `p`'s `keys` at their samples, or at `values` where it names them. */
export function fieldsAt(p: PositionId, keys: readonly string[], values: Readonly<Record<string, unknown>> = {}): Doc {
  return pick(samplesAt(p) as Record<string, unknown>, keys, values);
}

export function loadableKeySets(p: PositionId, keys: readonly string[]): string[][] {
  let sets: string[][] = [[...keys]];
  for (const group of ONE_OF_KEYS.filter((g) => g.position === p)) {
    const members: readonly string[] = group.keys;
    const held = members.filter((k) => keys.includes(k));
    if (held.length < 2) continue;
    sets = sets.flatMap((set) => held.map((keep) => set.filter((k) => k === keep || !members.includes(k))));
  }
  return sets;
}

export function oneOfFirstMembers(p: PositionId): string[] {
  return ONE_OF_KEYS.filter((g) => g.position === p).map((g) => g.keys[0]);
}

export type DefLoad = { ok: true } | { ok: false; reason: string };

/** Loads, through its own loader, the whole definition that holds `fields` at position `p`. */
export function loadAt(p: PositionId, fields: Doc): DefLoad {
  if (POSITIONS[p].definition === 'flow') {
    const load = loadFlowDoc(flowWith(p as FlowPositionId, fields));
    return load.ok ? { ok: true } : { ok: false, reason: load.error };
  }
  const load = loadLoopDoc(loopWith(p as LoopPositionId, fields));
  return load.ok ? { ok: true } : { ok: false, reason: load.reason };
}

/** Loads the definition that holds `value` under `set`'s key, every other key of its position at its sample. */
export function loadWithValue(set: Pick<ClosedSet, 'position' | 'key'>, value: unknown): DefLoad {
  const drop = DROPPED_BY_VALUE.find((d) => d.set.position === set.position && d.set.key === set.key && d.value === value)?.drop ?? [];
  return loadAt(set.position, fieldsAt(set.position, positionKeys(set.position).filter((k) => !drop.includes(k)), { [set.key]: value }));
}

export interface PlantedTiers {
  ctx: LoopDefV2Context;
  /** The definition directory a loop planted in `tier` resolves to. */
  defDirOf(tier: TierId): string;
  dispose(): void;
}

/** The same valid loop named `SAMPLE_LOOP` planted in each of `tiers`, laid out by the oracle's own layout. */
export function plantLoopInTiers(tiers: readonly TierId[]): PlantedTiers {
  const repoDir = tempDir('capability-tiers-repo-');
  const operator = tempDir('capability-tiers-operator-');
  const appBundled = tempDir('capability-tiers-app-');
  const repoDefRel = path.join('loops', LOOP_LAYOUT.defRelPath(SAMPLE_LOOP));
  const defFile: Record<TierId, string> = {
    'repo-override': path.join(repoDir, repoDefRel),
    'flow-folder-operator': path.join(operator, SAMPLE_FLOW, LOOP_LAYOUT.defRelPath(SAMPLE_LOOP)),
    'flow-folder-app-bundled': path.join(appBundled, SAMPLE_FLOW, LOOP_LAYOUT.defRelPath(SAMPLE_LOOP)),
    operator: path.join(operator, LOOP_LAYOUT.defRelPath(SAMPLE_LOOP)),
    'app-bundled': path.join(appBundled, LOOP_LAYOUT.defRelPath(SAMPLE_LOOP)),
  };
  for (const tier of tiers) {
    plantLoopDef(defFile[tier], LOOP_BASE);
    if (tier === 'repo-override') {
      writeFileSync(path.join(repoDir, LOOP_LAYOUT.overrideFile), yaml.dump({ [LOOP_LAYOUT.overrideMapKey]: { [SAMPLE_LOOP]: repoDefRel } }));
    }
  }
  return {
    ctx: { tiers: { operator, appBundled, retired: null }, repoDir, flow: SAMPLE_FLOW },
    defDirOf: (tier) => path.dirname(defFile[tier]),
    dispose: () => {
      for (const dir of [repoDir, operator, appBundled]) rmSync(dir, { recursive: true, force: true });
    },
  };
}
