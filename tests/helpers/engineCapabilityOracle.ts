// The independent expected result for #276's engine-capabilities descriptor: what the flow loader, the loop
// loader and the engine's dispatch sites accept and act on, written by hand from the code as it stood when
// the descriptor was introduced. It imports nothing from src/ (EXPECTED_RESULTS_FIXTURES in eslint.config.mjs),
// so a descriptor or guide that drops an entry cannot also drop it from here. A deliberate capability change
// edits this file in the same change.

export type Definition = 'flow' | 'loop';
export type Required = 'always' | 'never' | 'conditional';
export type UnreadKeys = 'rejected' | 'ignored';
export type Slice = 1 | 2 | 3;

export interface OraclePosition<K extends string> {
  definition: Definition;
  /** '' is the definition's top level. */
  yamlPath: string;
  unreadKeys: UnreadKeys;
  /** In the order the loader reads them. */
  keys: Readonly<Record<K, Required>>;
}

function position<const K extends string>(p: OraclePosition<K>): OraclePosition<K> {
  return p;
}

export const FLOW_POSITIONS = {
  flow: position({
    definition: 'flow',
    yamlPath: '',
    unreadKeys: 'ignored',
    keys: { name: 'always', steps: 'always' },
  }),
  'flow.steps[]': position({
    definition: 'flow',
    yamlPath: 'steps[]',
    unreadKeys: 'ignored',
    keys: {
      id: 'always',
      kind: 'always',
      loop: 'conditional',
      gate_authority: 'never',
      loop_namespace: 'never',
      skill: 'never',
      todo_template: 'never',
      bootstrap: 'never',
      inputs: 'never',
      repeat: 'never',
    },
  }),
  'flow.steps[].inputs[]': position({
    definition: 'flow',
    yamlPath: 'steps[].inputs[]',
    unreadKeys: 'ignored',
    keys: { name: 'always', type: 'always', required: 'never' },
  }),
  'flow.steps[].repeat': position({
    definition: 'flow',
    yamlPath: 'steps[].repeat',
    unreadKeys: 'ignored',
    keys: { back_to: 'always', count_input: 'always' },
  }),
} as const;

export const LOOP_POSITIONS = {
  loop: position({
    definition: 'loop',
    yamlPath: '',
    unreadKeys: 'rejected',
    keys: {
      version: 'always',
      name: 'never',
      brief: 'never',
      work: 'always',
      reviewers: 'always',
      consolidator: 'conditional',
      report: 'always',
      gate: 'always',
      exec: 'never',
      outputs: 'conditional',
      boundaries: 'always',
      pickup: 'never',
      inputs: 'never',
    },
  }),
  'loop.work': position({
    definition: 'loop',
    yamlPath: 'work',
    unreadKeys: 'ignored',
    keys: { recipe: 'always', artifact: 'always', completion: 'never', frozen_check: 'never', goal: 'never', checkpoint: 'never' },
  }),
  'loop.work.checkpoint': position({
    definition: 'loop',
    yamlPath: 'work.checkpoint',
    unreadKeys: 'ignored',
    keys: { passes: 'always' },
  }),
  'loop.reviewers[]': position({
    definition: 'loop',
    yamlPath: 'reviewers[]',
    unreadKeys: 'ignored',
    keys: { persona: 'always', charter: 'always', tools: 'never' },
  }),
  'loop.consolidator': position({
    definition: 'loop',
    yamlPath: 'consolidator',
    unreadKeys: 'ignored',
    keys: { recipe: 'always' },
  }),
  'loop.boundaries[]': position({
    definition: 'loop',
    yamlPath: 'boundaries[]',
    unreadKeys: 'ignored',
    keys: { boundary: 'always', mode: 'always', message: 'conditional' },
  }),
  'loop.report': position({
    definition: 'loop',
    yamlPath: 'report',
    unreadKeys: 'ignored',
    keys: { sections: 'always', polish: 'never' },
  }),
  'loop.gate[]': position({
    definition: 'loop',
    yamlPath: 'gate[]',
    unreadKeys: 'ignored',
    keys: { option: 'always', side_effects: 'never' },
  }),
  // Every key other than `kind` is kept as the side-effect's args; SIDE_EFFECT_ARGS lists the args each kind reads.
  'loop.gate[].side_effects[]': position({
    definition: 'loop',
    yamlPath: 'gate[].side_effects[]',
    unreadKeys: 'ignored',
    keys: { kind: 'always' },
  }),
  'loop.pickup': position({
    definition: 'loop',
    yamlPath: 'pickup',
    unreadKeys: 'ignored',
    keys: { initial_status: 'always', branch_template: 'always', initial_labels: 'never', on_conflict: 'never' },
  }),
  'loop.pickup.initial_labels[]': position({
    definition: 'loop',
    yamlPath: 'pickup.initial_labels[]',
    unreadKeys: 'ignored',
    keys: { action: 'always', target: 'always', label: 'always' },
  }),
  // One position for both lists: the loader parses `inputs` and `outputs` entries with the same rules.
  'loop.inputs[]/outputs[]': position({
    definition: 'loop',
    yamlPath: 'inputs[]/outputs[]',
    unreadKeys: 'ignored',
    keys: { id: 'always', path: 'always', sections_dir: 'never' },
  }),
  'loop.exec': position({
    definition: 'loop',
    yamlPath: 'exec',
    unreadKeys: 'ignored',
    keys: { program: 'always' },
  }),
} as const;

export type FlowPositionId = keyof typeof FLOW_POSITIONS;
export type LoopPositionId = keyof typeof LOOP_POSITIONS;
export type PositionId = FlowPositionId | LoopPositionId;
export type FlowKeyOf<P extends FlowPositionId> = keyof (typeof FLOW_POSITIONS)[P]['keys'] & string;
export type LoopKeyOf<P extends LoopPositionId> = keyof (typeof LOOP_POSITIONS)[P]['keys'] & string;

export const POSITIONS: Readonly<Record<PositionId, OraclePosition<string>>> = { ...FLOW_POSITIONS, ...LOOP_POSITIONS };

export function positionKeys(id: PositionId): string[] {
  return Object.keys(POSITIONS[id].keys);
}

export function requiredKeys(id: PositionId, required: Required): string[] {
  return Object.entries(POSITIONS[id].keys)
    .filter(([, r]) => r === required)
    .map(([k]) => k);
}

/** A key named together with the position it sits at; a key the position does not list does not compile. */
export type PositionKey =
  | { [P in FlowPositionId]: { position: P; key: FlowKeyOf<P> } }[FlowPositionId]
  | { [P in LoopPositionId]: { position: P; key: LoopKeyOf<P> } }[LoopPositionId];

export type ClosedValue = string | boolean;

export type ClosedSet = PositionKey & { values: readonly ClosedValue[]; slice: Slice };

export const CLOSED_SETS: readonly ClosedSet[] = [
  { position: 'flow.steps[]', key: 'kind', values: ['manual', 'loop'], slice: 1 },
  { position: 'flow.steps[]', key: 'gate_authority', values: ['human', 'auto'], slice: 1 },
  { position: 'flow.steps[]', key: 'loop_namespace', values: ['app', 'legacy'], slice: 1 },
  { position: 'flow.steps[]', key: 'bootstrap', values: ['pickup'], slice: 1 },
  { position: 'loop', key: 'version', values: ['v2'], slice: 2 },
  { position: 'loop.work', key: 'completion', values: ['red', 'green', 'refactor'], slice: 2 },
  { position: 'loop.work', key: 'frozen_check', values: [true], slice: 2 },
  { position: 'loop.boundaries[]', key: 'mode', values: ['clear', 'compact'], slice: 2 },
  { position: 'loop.report', key: 'polish', values: ['fix', 'defer'], slice: 2 },
  { position: 'loop.pickup', key: 'on_conflict', values: ['abort', 'wipe-and-retry'], slice: 2 },
  { position: 'loop.pickup.initial_labels[]', key: 'action', values: ['add', 'remove'], slice: 2 },
  { position: 'loop.pickup.initial_labels[]', key: 'target', values: ['issue', 'pr'], slice: 2 },
];

/** Whether each accepted `loop_namespace` selects an engine that runs the step. */
export const LOOP_NAMESPACE_RUNS_ENGINE: Readonly<Record<'app' | 'legacy', boolean>> = { app: true, legacy: false };

export const ACTED_INPUT_TYPES = ['github-ticket', 'pr'] as const;
export const ACTED_GATE_OPTIONS = ['approve', 'request-changes', 'impasse', 'redo', 'polish', 'back-to-red'] as const;
export const ACTED_SIDE_EFFECT_KINDS = ['gh', 'commit', 'promote'] as const;
export const ACTED_GH_ACTIONS = ['mark-ready', 'update-issue-body', 'publish-pr-body'] as const;

export type OracleActedInputType = (typeof ACTED_INPUT_TYPES)[number];
export type OracleActedGateOption = (typeof ACTED_GATE_OPTIONS)[number];
export type OracleActedSideEffectKind = (typeof ACTED_SIDE_EFFECT_KINDS)[number];
export type OracleActedGhAction = (typeof ACTED_GH_ACTIONS)[number];

/** The side-effect args the engine reads for each acted-on kind. */
export const SIDE_EFFECT_ARGS = {
  gh: ['action', 'artifact'],
  commit: ['label'],
  promote: ['artifact'],
} as const satisfies Readonly<Record<OracleActedSideEffectKind, readonly string[]>>;

/** The key an open-set name is written under: a position's key, or for `gh` actions the side-effect's `action` arg. */
type OpenSetKey = PositionKey | { position: 'loop.gate[].side_effects[]'; key: (typeof SIDE_EFFECT_ARGS)['gh'][number] };

export type OpenSet = OpenSetKey & {
  acted: readonly string[];
  /** Names the loader refuses although the key is otherwise open. */
  loadRejected: readonly string[];
  slice: Slice;
};

export const OPEN_SETS = {
  inputType: { position: 'flow.steps[].inputs[]', key: 'type', acted: ACTED_INPUT_TYPES, loadRejected: [], slice: 1 },
  gateOption: { position: 'loop.gate[]', key: 'option', acted: ACTED_GATE_OPTIONS, loadRejected: [], slice: 2 },
  sideEffectKind: { position: 'loop.gate[].side_effects[]', key: 'kind', acted: ACTED_SIDE_EFFECT_KINDS, loadRejected: ['exec'], slice: 2 },
  ghAction: { position: 'loop.gate[].side_effects[]', key: 'action', acted: ACTED_GH_ACTIONS, loadRejected: [], slice: 2 },
} as const satisfies Record<string, OpenSet>;

export type CrossFieldRule = PositionKey & { rule: string; slice: Slice };

/** Every rule the loaders enforce across fields, conditional requirements included. Ids, never wording. */
export const CROSS_FIELD_RULES = [
  { position: 'flow.steps[]', key: 'loop', rule: 'loop-step-needs-loop', slice: 1 },
  { position: 'flow.steps[]', key: 'gate_authority', rule: 'gate-authority-only-on-loop-step', slice: 1 },
  { position: 'flow.steps[]', key: 'loop_namespace', rule: 'app-namespace-needs-safe-loop-name', slice: 1 },
  { position: 'flow.steps[].repeat', key: 'back_to', rule: 'back-to-names-earlier-step', slice: 1 },
  { position: 'loop', key: 'name', rule: 'declared-name-matches-resolved-name', slice: 2 },
  { position: 'loop', key: 'consolidator', rule: 'goal-excludes-consolidator', slice: 2 },
  { position: 'loop', key: 'reviewers', rule: 'reviewers-need-consolidator-or-goal', slice: 2 },
  { position: 'loop', key: 'outputs', rule: 'result-completion-needs-artifact-output', slice: 2 },
  { position: 'loop.work', key: 'checkpoint', rule: 'checkpoint-needs-goal', slice: 2 },
  { position: 'loop.gate[]', key: 'option', rule: 'request-changes-needs-review-rounds', slice: 2 },
  { position: 'loop.boundaries[]', key: 'message', rule: 'compact-needs-message', slice: 2 },
  { position: 'loop.inputs[]/outputs[]', key: 'id', rule: 'id-declared-once', slice: 2 },
] as const satisfies readonly CrossFieldRule[];

export type OracleRuleId = (typeof CROSS_FIELD_RULES)[number]['rule'];

/** Keys checked at run time, never at load. */
export const NOT_CHECKED_AT_LOAD = [{ position: 'flow.steps[].repeat', key: 'count_input', slice: 1 }] as const satisfies readonly (PositionKey & { slice: Slice })[];

/** Where a `{…}` slot fails to load. */
export const SLOT_REJECTING: readonly PositionKey[] = [
  { position: 'loop', key: 'brief' },
  { position: 'loop.work', key: 'recipe' },
  { position: 'loop.reviewers[]', key: 'charter' },
  { position: 'loop.consolidator', key: 'recipe' },
  { position: 'loop.inputs[]/outputs[]', key: 'path' },
  { position: 'loop.inputs[]/outputs[]', key: 'sections_dir' },
];

/** Where a slot is expanded, and the slot. */
export const SLOT_EXPANDING: readonly (PositionKey & { slot: string })[] = [
  { position: 'loop.pickup', key: 'branch_template', slot: '{issue}' },
];

/** §27.8: the order a loop name resolves in, first found wins. */
export const LOOKUP_ORDER = ['repo-override', 'flow-folder-operator', 'flow-folder-app-bundled', 'operator', 'app-bundled'] as const;
export type TierId = (typeof LOOKUP_ORDER)[number];

/** The on-disk layout the resolver reads, written out by hand. */
export const LOOP_LAYOUT = {
  overrideFile: '.agent-loop.yaml',
  overrideMapKey: 'loops',
  defRelPath: (name: string): string => `${name}/${name}.yaml`,
} as const;

export const LOOP_CAPABILITIES_KEYS: Readonly<Record<string, Required>> = {
  test_globs: 'always',
  test_command: 'always',
  build_command: 'always',
  select_template: 'never',
  red_check_command: 'never',
};

export const TURN_KINDS = ['work', 'review', 'consolidate'] as const;

export type SectionKind = 'position' | 'where-things-live' | 'lookup-order' | 'turn-contract' | 'turn-composition';

export type OracleSection =
  | { kind: 'position'; position: PositionId; slice: Slice }
  | { kind: Exclude<SectionKind, 'position'>; slice: Slice };

/** The sections the guide carries, by what they are; the slice that adds each. */
export const SECTIONS: readonly OracleSection[] = [
  ...(Object.keys(FLOW_POSITIONS) as FlowPositionId[]).map((p) => ({ kind: 'position' as const, position: p, slice: 1 as const })),
  { kind: 'where-things-live' as const, slice: 1 as const },
  { kind: 'lookup-order' as const, slice: 1 as const },
  ...(Object.keys(LOOP_POSITIONS) as LoopPositionId[]).map((p) => ({ kind: 'position' as const, position: p, slice: 2 as const })),
  { kind: 'turn-contract' as const, slice: 3 as const },
  { kind: 'turn-composition' as const, slice: 3 as const },
];

export function sectionsThrough(slice: Slice): OracleSection[] {
  return SECTIONS.filter((s) => s.slice <= slice);
}
