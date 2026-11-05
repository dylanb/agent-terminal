import { GATE_DECISION_OPTIONS, type GateDecisionOption } from '../ipc/flow';
import type { ActedName, ClosedValue, Explanation, KeyCapability, KeyValues, PositionCapability } from './index';

export const APPROVE_OPTION = 'approve' satisfies GateDecisionOption;
export const REQUEST_CHANGES_OPTION = 'request-changes' satisfies GateDecisionOption;

export const ISSUE_SLOT = '{issue}';

export const LOOP_DEF_V2_VERSION = 'v2';
const LOOP_DEF_VERSIONS = [LOOP_DEF_V2_VERSION] as const;
type LoopDefVersion = (typeof LOOP_DEF_VERSIONS)[number];

export const WORK_COMPLETIONS = ['red', 'green', 'refactor'] as const;
export type WorkCompletion = (typeof WORK_COMPLETIONS)[number];

export const FROZEN_CHECK_VALUES = [true] as const;

export const BOUNDARY_MODES = ['clear', 'compact'] as const;
export const PRE_REVIEW_BOUNDARY = 'pre-review';
export const PRE_CONSOLIDATE_BOUNDARY = 'pre-consolidate';
export type BoundaryMode = (typeof BOUNDARY_MODES)[number];

export const POLISH_POLICIES = ['fix', 'defer'] as const;
export type PolishPolicy = (typeof POLISH_POLICIES)[number];

export const PICKUP_CONFLICT_POLICIES = ['abort', 'wipe-and-retry'] as const;
export type PickupConflictPolicy = (typeof PICKUP_CONFLICT_POLICIES)[number];

export const PICKUP_LABEL_ACTIONS = ['add', 'remove'] as const;
export type PickupLabelAction = (typeof PICKUP_LABEL_ACTIONS)[number];

export const PICKUP_LABEL_TARGETS = ['issue', 'pr'] as const;
export type PickupLabelTarget = (typeof PICKUP_LABEL_TARGETS)[number];

export const ACTED_SIDE_EFFECT_KINDS = ['gh', 'commit', 'promote'] as const;
export type ActedSideEffectKind = (typeof ACTED_SIDE_EFFECT_KINDS)[number];
export const PROMOTE_KIND = 'promote' satisfies ActedSideEffectKind;

/** The side-effect kind the loader refuses: a program is declared once, on the top-level `exec` key (CWE-829). */
export const EXEC_SIDE_EFFECT_KIND = 'exec';

export const ACTED_GH_ACTIONS = ['mark-ready', 'update-issue-body', 'publish-pr-body'] as const;
export type ActedGhAction = (typeof ACTED_GH_ACTIONS)[number];

/** The agent caps a goal at 4000 characters, and the engine's framing around the condition must fit beside it. */
export const GOAL_CONDITION_MAX_CHARS = 2000;

function closed<V extends string | boolean>(values: readonly V[], docs: (value: V) => Explanation): KeyValues {
  return { kind: 'closed', values: values.map((value): ClosedValue => ({ value, ...docs(value) })) };
}

const byName =
  <V extends string>(docs: Readonly<Record<V, Explanation>>) =>
  (value: V): Explanation =>
    docs[value];

function acted<V extends string>(names: readonly V[], docs: Readonly<Record<V, Explanation>>, args: Partial<Readonly<Record<V, readonly KeyCapability[]>>> = {}): readonly ActedName[] {
  return names.map((name) => ({ name, ...docs[name], ...(args[name] === undefined ? {} : { args: args[name] }) }));
}

const code = (s: string): string => `\`${s}\``;

const VERSION_DOCS: Record<LoopDefVersion, Explanation> = {
  v2: {
    does: 'The loop-definition schema this engine reads.',
    when: 'Always: it is the only version the engine loads.',
  },
};

const COMPLETION_DOCS: Record<WorkCompletion, Explanation> = {
  red: {
    does: 'The work turn writes failing tests: the step completes only when its result file shows the new tests failing by assertion.',
    when: 'Choose it for the test-first step of a red, green, refactor cycle.',
  },
  green: {
    does: 'The work turn makes the tests pass: the step completes only when its result file shows the tests passing and the build succeeding, with the previous phase’s tests left unchanged.',
    when: 'Choose it for the step that implements what the failing tests describe.',
  },
  refactor: {
    does: 'Each review-and-fix round is gated instead of the work turn, which writes no result file; the previous phase’s tests must stay unchanged.',
    when: 'Choose it for a clean-up step that must keep behaviour and tests as they are.',
  },
};

const FROZEN_CHECK_DOCS = (): Explanation => ({
  does: 'Holds the tests the previous phase committed frozen: before the gate opens, the engine checks that this loop’s work did not change them.',
  when: 'Set it on a loop whose completion is not `green` or `refactor` (those already run the check) that must not touch existing tests. It is the only value.',
});

const BOUNDARY_MODE_DOCS: Record<BoundaryMode, Explanation> = {
  clear: {
    does: 'Clears the agent’s context at the boundary, so the next turn starts from its prompt alone.',
    when: 'Choose it when the next turn should not see the work before it, for example before reviews.',
  },
  compact: {
    does: 'Compacts the agent’s context at the boundary, keeping what `message` names.',
    when: 'Choose it when the next turn needs a summary of what came before.',
  },
};

const POLISH_DOCS: Record<PolishPolicy, Explanation> = {
  fix: {
    does: 'Review rounds fix polish-only findings as well as defects.',
    when: 'Choose it, or leave the key out, for a loop that should leave its work fully polished. It is the default.',
  },
  defer: {
    does: 'Review rounds dismiss polish-only findings, leaving them to a later loop that reviews the whole change.',
    when: 'Choose it for an early loop in a flow whose later loop polishes the work.',
  },
};

const CONFLICT_DOCS: Record<PickupConflictPolicy, Explanation> = {
  abort: {
    does: 'When the branch already exists locally, on the remote or with an open pull request, pickup stops and asks a person.',
    when: 'Choose it, or leave the key out, to never lose earlier work on the branch. It is the default.',
  },
  'wipe-and-retry': {
    does: 'When the branch already exists, pickup offers to delete it and its pull request and start again.',
    when: 'Choose it for a loop whose earlier attempts are safe to throw away.',
  },
};

const LABEL_ACTION_DOCS: Record<PickupLabelAction, Explanation> = {
  add: { does: 'Adds the label.', when: 'Choose it to mark the ticket or pull request as picked up.' },
  remove: { does: 'Removes the label.', when: 'Choose it to clear a label such as a "ready" marker on pickup.' },
};

const LABEL_TARGET_DOCS: Record<PickupLabelTarget, Explanation> = {
  issue: { does: 'Applies the change to the run’s ticket.', when: 'Choose it for a label on the GitHub issue.' },
  pr: { does: 'Applies the change to the pull request pickup opens.', when: 'Choose it for a label on the pull request.' },
};

const GATE_OPTION_DOCS: Record<GateDecisionOption, Explanation> = {
  approve: {
    does: 'Accepts the artifact and moves the flow to its next step, running the option’s `side_effects` first.',
    when: 'Declare it on every loop that should be able to finish.',
  },
  'request-changes': {
    does: 'Sends a person’s written feedback into another review-and-fix round.',
    when: 'Declare it on a loop with a `consolidator`, so a person can ask for specific changes.',
  },
  impasse: {
    does: 'Shows a button that does nothing when taken: the engine runs no action for it.',
    when: 'Declare it only to show that the loop can end in an impasse; it never moves the run.',
  },
  redo: {
    does: 'Starts the work turn again from a clean slate with a person’s written instruction.',
    when: 'Declare it when a person may want the work redone rather than revised.',
  },
  polish: {
    does: 'Stands the loop down so a person can polish the work by hand; Approve ends it.',
    when: 'Declare it on a loop whose output a person may want to finish themselves.',
  },
  'back-to-red': {
    does: 'Returns the flow to the current slice’s red step, with an optional written brief, so the slice is redone from its tests.',
    when: 'Declare it on the green and refactor loops of a red, green, refactor cycle.',
  },
};

const SIDE_EFFECT_KIND_DOCS: Record<ActedSideEffectKind, Explanation> = {
  gh: {
    does: 'Runs a GitHub action against the run’s pull request or ticket, named by `action`.',
    when: 'Choose it to publish a loop’s output to GitHub or mark the pull request ready.',
  },
  commit: {
    does: 'Commits the work under `label`, then pushes the branch when pickup opened one.',
    when: 'Choose it on each phase loop of a flow that should record one commit per phase.',
  },
  promote: {
    does: 'Reads the plan named by `artifact` and, when it is an epic, offers to promote its sub-tickets before the approval completes.',
    when: 'Choose it on a planning loop whose plan may split the work into sub-tickets.',
  },
};

const GH_ACTION_DOCS: Record<ActedGhAction, Explanation> = {
  'mark-ready': {
    does: 'Marks the run’s draft pull request ready for review. With no pull request it is skipped with a notice.',
    when: 'Choose it on the last loop of a flow, when the work is ready for people to review.',
  },
  'update-issue-body': {
    does: 'Replaces the ticket’s body with the file named by `artifact`. With no ticket it is skipped with a notice; an empty file fails.',
    when: 'Choose it on a grooming loop whose output is the ticket itself.',
  },
  'publish-pr-body': {
    does: 'Replaces the pull request’s description with the file named by `artifact`. With no pull request it is skipped with a notice; an empty file fails.',
    when: 'Choose it on a loop that writes the pull request’s description.',
  },
};

const anyArg = (key: string, docs: Explanation, required: KeyCapability['required'], values: KeyValues = { kind: 'any' }): KeyCapability => ({
  key,
  ...docs,
  required,
  rules: [],
  values,
});

const ARTIFACT_ARG_DOES = 'The `id` of one of the definition’s `inputs` or `outputs`, whose file the side effect reads.';

const SIDE_EFFECT_ARGS: Readonly<Record<ActedSideEffectKind, readonly KeyCapability[]>> = {
  gh: [
    anyArg(
      'action',
      { does: 'The GitHub action to run.', when: 'Always set it; a `gh` side effect does nothing useful without one.' },
      { kind: 'conditional', condition: 'the option is taken: without it the side effect fails. The loader does not check it.' },
      {
        kind: 'open',
        acted: acted(ACTED_GH_ACTIONS, GH_ACTION_DOCS),
        otherNames: 'Any other name, or none, loads; taking the option then fails the side effect, which is recorded in the run’s audit log and shown as an error.',
      },
    ),
    anyArg(
      'artifact',
      { does: ARTIFACT_ARG_DOES, when: 'Set it for an action that publishes a file.' },
      { kind: 'conditional', condition: 'the `action` is `update-issue-body` or `publish-pr-body`: without it, or when it names no binding, the side effect fails.' },
    ),
  ],
  commit: [
    anyArg(
      'label',
      { does: 'The phase name the commit is recorded under.', when: 'Always set it, for example to the phase the loop runs.' },
      { kind: 'conditional', condition: 'the option is taken: without it the commit fails. The loader does not check it.' },
    ),
  ],
  promote: [
    anyArg(
      'artifact',
      { does: ARTIFACT_ARG_DOES, when: 'Set it to the plan the loop writes.' },
      { kind: 'conditional', condition: 'the option is taken: without it no promotion is offered. The loader does not check it.' },
    ),
  ],
};

const any = { kind: 'any' } as const;
const always = { kind: 'always' } as const;
const never = { kind: 'never' } as const;
const slotRejected = 'It is a path, never a body, and a `{…}` slot in it fails to load.';

const LOOP_TOP: PositionCapability = {
  definition: 'loop',
  yamlPath: '',
  unreadKeys: 'rejected',
  keys: [
    {
      key: 'version',
      does: 'The schema version of the definition.',
      when: 'Always set it.',
      required: always,
      rules: [],
      values: closed(LOOP_DEF_VERSIONS, byName(VERSION_DOCS)),
    },
    {
      key: 'name',
      does: 'The loop’s name. The engine names a loop by the folder and file it resolves from, so this only restates it.',
      when: 'Leave it out, or set it to the name the loop resolves by.',
      required: never,
      rules: [{ id: 'declared-name-matches-resolved-name', text: 'A `name` other than the name the loop resolves by fails to load.' }],
      values: any,
    },
    {
      key: 'brief',
      does: `A Markdown file, relative to the definition, that opens every work turn's prompt with the role the agent plays. ${slotRejected}`,
      when: 'Set it when every work turn of the loop shares one role description.',
      required: never,
      rules: [],
      values: any,
      slots: { kind: 'rejected' },
    },
    {
      key: 'work',
      does: 'The work turn: the recipe the agent follows and the artifact it produces.',
      when: 'Always set it.',
      required: always,
      rules: [],
      values: any,
    },
    {
      key: 'reviewers',
      does: 'The reviewers that review the work, each a persona with its charter.',
      when: 'Always set it to a list; leave the list empty for a loop with no reviews.',
      required: always,
      rules: [
        {
          id: 'reviewers-need-consolidator-or-goal',
          text: 'A non-empty list fails to load unless a `consolidator` judges the review rounds or a `work.goal` runs the reviewers itself.',
        },
      ],
      values: any,
    },
    {
      key: 'consolidator',
      does: 'The turn that merges the reviewers’ findings each round into one verdict.',
      when: 'Set it on a loop whose review rounds the engine runs one by one.',
      required: { kind: 'conditional', condition: 'the loop declares reviewers and no `work.goal`.' },
      rules: [{ id: 'goal-excludes-consolidator', text: 'Declaring it beside a `work.goal` fails to load: a goal session runs its reviewers itself.' }],
      values: any,
    },
    {
      key: 'report',
      does: 'The structure of each review round’s report.',
      when: 'Always set it.',
      required: always,
      rules: [],
      values: any,
    },
    {
      key: 'gate',
      does: 'The options a person, or the gate authority, can take once the loop reaches its gate.',
      when: 'Always set it to a list; a loop that should finish declares `approve`.',
      required: always,
      rules: [],
      values: any,
    },
    {
      key: 'exec',
      does: 'A program the definition declares. Declared but not shipped: the loader reads it and no engine runs it.',
      when: 'Leave it out.',
      required: never,
      rules: [],
      values: any,
    },
    {
      key: 'outputs',
      does: 'The files the loop writes, each bound to an `id` the work turn, the gate and later steps refer to.',
      when: 'Set it for every file the loop produces.',
      required: { kind: 'conditional', condition: '`work.completion` is `red` or `green`: one output’s `id` must be `work.artifact`.' },
      rules: [
        {
          id: 'result-completion-needs-artifact-output',
          text: 'With `work.completion` `red` or `green`, a `work.artifact` that names no output fails to load.',
        },
      ],
      values: any,
    },
    {
      key: 'boundaries',
      does: 'The context policy at each point the engine changes turn.',
      when: 'Always set it to a list; leave it empty to clear the context at every point the engine changes turn.',
      required: always,
      rules: [],
      values: any,
    },
    {
      key: 'pickup',
      does: 'What a flow step’s `bootstrap: pickup` does for the ticket: the branch it opens, the status it sets and the labels it changes.',
      when: 'Set it on the loop of a flow step that starts work on a ticket.',
      required: never,
      rules: [],
      values: any,
    },
    {
      key: 'inputs',
      does: 'The files the loop reads, each bound to an `id`.',
      when: 'Set it for every file an earlier step wrote that the loop needs.',
      required: never,
      rules: [],
      values: any,
    },
  ],
};

export const LOOP_TOP_KEYS: readonly string[] = LOOP_TOP.keys.map((k) => k.key);

export const LOOP_POSITIONS: readonly PositionCapability[] = [
  LOOP_TOP,
  {
    definition: 'loop',
    yamlPath: 'work',
    unreadKeys: 'ignored',
    keys: [
      {
        key: 'recipe',
        does: `A Markdown file, relative to the definition, holding the instructions the work turn follows. ${slotRejected}`,
        when: 'Always set it.',
        required: always,
        rules: [],
        values: any,
        slots: { kind: 'rejected' },
      },
      {
        key: 'artifact',
        does: 'The `id` of the output the work turn produces.',
        when: 'Always set it.',
        required: always,
        rules: [],
        values: any,
      },
      {
        key: 'completion',
        does: 'Which machine check the step’s completion waits on.',
        when: 'Set it on a test-driven phase loop; leave it out for a loop a person or a review approves.',
        required: never,
        rules: [],
        values: closed(WORK_COMPLETIONS, byName(COMPLETION_DOCS)),
      },
      {
        key: 'frozen_check',
        does: 'Whether the loop runs the frozen-tests check.',
        when: 'Leave it out unless the loop must not change existing tests.',
        required: never,
        rules: [],
        values: closed(FROZEN_CHECK_VALUES, FROZEN_CHECK_DOCS),
      },
      {
        key: 'goal',
        does: `Runs the work as one agent goal session that ends when this condition holds, with the agent running its reviewers itself. One line, at most ${GOAL_CONDITION_MAX_CHARS} characters.`,
        when: 'Set it for a loop the agent should drive to completion on its own.',
        required: never,
        rules: [],
        values: any,
      },
      {
        key: 'checkpoint',
        does: 'Splits a goal session into legs: after the given number of review passes the session is compacted and resumes.',
        when: 'Set it on a long goal session whose context would otherwise fill.',
        required: never,
        rules: [{ id: 'checkpoint-needs-goal', text: 'Declaring it without `goal` fails to load: only a goal session runs in legs.' }],
        values: any,
      },
    ],
  },
  {
    definition: 'loop',
    yamlPath: 'work.checkpoint',
    unreadKeys: 'ignored',
    keys: [
      {
        key: 'passes',
        does: 'How many review passes a leg runs before the session checkpoints.',
        when: 'Always set it to a whole number of at least 1.',
        required: always,
        rules: [],
        values: any,
      },
    ],
  },
  {
    definition: 'loop',
    yamlPath: 'reviewers[]',
    unreadKeys: 'ignored',
    keys: [
      {
        key: 'persona',
        does: 'The reviewer’s name, a single path segment. The agent each review round calls is named after the loop and this persona.',
        when: 'Always set it.',
        required: always,
        rules: [],
        values: any,
      },
      {
        key: 'charter',
        does: `A Markdown file, relative to the definition, holding the reviewer's instructions. ${slotRejected}`,
        when: 'Always set it.',
        required: always,
        rules: [],
        values: any,
        slots: { kind: 'rejected' },
      },
      {
        key: 'tools',
        does: 'The tools the reviewer may use, as a list of tool names; with no list it may use every tool.',
        when: 'Set it to keep a reviewer read-only or narrow.',
        required: never,
        rules: [],
        values: any,
      },
    ],
  },
  {
    definition: 'loop',
    yamlPath: 'consolidator',
    unreadKeys: 'ignored',
    keys: [
      {
        key: 'recipe',
        does: `A Markdown file, relative to the definition, holding the instructions the consolidating turn follows. ${slotRejected}`,
        when: 'Always set it.',
        required: always,
        rules: [],
        values: any,
        slots: { kind: 'rejected' },
      },
    ],
  },
  {
    definition: 'loop',
    yamlPath: 'boundaries[]',
    unreadKeys: 'ignored',
    keys: [
      {
        key: 'boundary',
        does: `The point the policy applies at: the first boundary listed applies before the work turn, the one named ${code(PRE_REVIEW_BOUNDARY)} before each review round, and the one named ${code(PRE_CONSOLIDATE_BOUNDARY)} before each consolidating turn. A point with no boundary declared clears the context.`,
        when: 'Always set it.',
        required: always,
        rules: [],
        values: any,
      },
      {
        key: 'mode',
        does: 'What happens to the agent’s context at the boundary.',
        when: 'Always set it.',
        required: always,
        rules: [],
        values: closed(BOUNDARY_MODES, byName(BOUNDARY_MODE_DOCS)),
      },
      {
        key: 'message',
        does: 'What the compacted context keeps.',
        when: 'Set it on every `compact` boundary.',
        required: { kind: 'conditional', condition: 'the `mode` is `compact`.' },
        rules: [{ id: 'compact-needs-message', text: 'A `compact` boundary without a `message` fails to load.' }],
        values: any,
      },
    ],
  },
  {
    definition: 'loop',
    yamlPath: 'report',
    unreadKeys: 'ignored',
    keys: [
      {
        key: 'sections',
        does: 'The sections each round report must carry, as a list of strings.',
        when: 'Always set it.',
        required: always,
        rules: [],
        values: any,
      },
      {
        key: 'polish',
        does: 'What review rounds do with a finding that is polish only.',
        when: 'Set it to `defer` only when a later loop polishes the work.',
        required: never,
        rules: [],
        values: closed(POLISH_POLICIES, byName(POLISH_DOCS)),
      },
    ],
  },
  {
    definition: 'loop',
    yamlPath: 'gate[]',
    unreadKeys: 'ignored',
    keys: [
      {
        key: 'option',
        does: 'The option’s name, shown as a button on the gate.',
        when: 'Always set it; declare each option a person should be able to take.',
        required: always,
        rules: [{ id: 'request-changes-needs-review-rounds', text: 'A `request-changes` option on a loop with no `consolidator` fails to load: it re-enters a review round, and only a consolidator’s rounds can be re-entered.' }],
        values: {
          kind: 'open',
          acted: acted(GATE_DECISION_OPTIONS, GATE_OPTION_DOCS),
          otherNames: 'Any other name loads and shows as a button, but taking it does nothing: the app refuses it before it reaches the engine.',
        },
      },
      {
        key: 'side_effects',
        does: 'What the engine runs when the option is `approve`, in the order listed; on any other option they never run.',
        when: 'Set it on the `approve` option to publish, commit or promote the loop’s work.',
        required: never,
        rules: [],
        values: any,
      },
    ],
  },
  {
    definition: 'loop',
    yamlPath: 'gate[].side_effects[]',
    unreadKeys: 'ignored',
    keys: [
      {
        key: 'kind',
        does: 'What the side effect does. Every other key of the entry is kept as the side effect’s args, which the loader does not check; the args each kind reads are listed under it.',
        when: 'Always set it.',
        required: always,
        rules: [],
        values: {
          kind: 'open',
          acted: acted(ACTED_SIDE_EFFECT_KINDS, SIDE_EFFECT_KIND_DOCS, SIDE_EFFECT_ARGS),
          otherNames: `${code(EXEC_SIDE_EFFECT_KIND)} fails to load: a program is declared on the top-level ${code('exec')} key instead. Any other kind loads and is skipped when the option is taken.`,
        },
      },
    ],
  },
  {
    definition: 'loop',
    yamlPath: 'pickup',
    unreadKeys: 'ignored',
    keys: [
      {
        key: 'initial_status',
        does: 'The status pickup sets on the ticket.',
        when: 'Always set it to a non-blank status.',
        required: always,
        rules: [],
        values: any,
      },
      {
        key: 'branch_template',
        does: `The name of the branch pickup opens, with \`${ISSUE_SLOT}\` replaced by the ticket number.`,
        when: 'Always set it.',
        required: always,
        rules: [],
        values: any,
        slots: { kind: 'expanded', slot: ISSUE_SLOT },
      },
      {
        key: 'initial_labels',
        does: 'Label changes pickup makes, in order.',
        when: 'Set it to mark the ticket or pull request as in progress.',
        required: never,
        rules: [],
        values: any,
      },
      {
        key: 'on_conflict',
        does: 'What pickup does when the branch already exists.',
        when: 'Leave it out to stop and ask.',
        required: never,
        rules: [],
        values: closed(PICKUP_CONFLICT_POLICIES, byName(CONFLICT_DOCS)),
      },
    ],
  },
  {
    definition: 'loop',
    yamlPath: 'pickup.initial_labels[]',
    unreadKeys: 'ignored',
    keys: [
      {
        key: 'action',
        does: 'Whether the label is added or removed.',
        when: 'Always set it.',
        required: always,
        rules: [],
        values: closed(PICKUP_LABEL_ACTIONS, byName(LABEL_ACTION_DOCS)),
      },
      {
        key: 'target',
        does: 'Where the label is changed.',
        when: 'Always set it.',
        required: always,
        rules: [],
        values: closed(PICKUP_LABEL_TARGETS, byName(LABEL_TARGET_DOCS)),
      },
      {
        key: 'label',
        does: 'The label’s name.',
        when: 'Always set it to a non-blank name the repository has.',
        required: always,
        rules: [],
        values: any,
      },
    ],
  },
  {
    definition: 'loop',
    yamlPath: 'inputs[]/outputs[]',
    unreadKeys: 'ignored',
    keys: [
      {
        key: 'id',
        does: 'The binding’s name, a single path segment; `work.artifact` and the side effects’ `artifact` refer to it.',
        when: 'Always set it.',
        required: always,
        rules: [{ id: 'id-declared-once', text: 'The same `id` declared twice in one list fails to load.' }],
        values: any,
      },
      {
        key: 'path',
        does: `The file's path inside the repository's loop artifacts folder; a path that leaves it fails to load. ${slotRejected}`,
        when: 'Always set it.',
        required: always,
        rules: [],
        values: any,
        slots: { kind: 'rejected' },
      },
      {
        key: 'sections_dir',
        does: `A folder inside the loop artifacts folder where each step writes its own section of this file; the engine assembles the file from them. ${slotRejected}`,
        when: 'Set it on a report several steps add to.',
        required: never,
        rules: [],
        values: any,
        slots: { kind: 'rejected' },
      },
    ],
  },
  {
    definition: 'loop',
    yamlPath: 'exec',
    unreadKeys: 'ignored',
    keys: [
      {
        key: 'program',
        does: 'The program to run. Declared but not shipped: no engine runs it.',
        when: 'Set it only when declaring `exec`.',
        required: always,
        rules: [],
        values: any,
      },
    ],
  },
];
