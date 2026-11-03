import { GATE_AUTHORITIES, type GateAuthority } from '../gateAuthority';
import { LOOP_NAMESPACES, RETIRED_LOOP_NAMESPACE, bindsNoSurvivingEngine, type LoopBinding } from '../loopNamespace';
import type { ActedName, ClosedValue, Explanation, KeyValues, PositionCapability } from './index';

export const FLOW_STEP_KINDS = ['manual', 'loop'] as const;
export type FlowStepKind = (typeof FLOW_STEP_KINDS)[number];

export const FLOW_BOOTSTRAPS = ['pickup'] as const;
export type FlowBootstrap = (typeof FLOW_BOOTSTRAPS)[number];

export const ACTED_INPUT_TYPES = ['github-ticket', 'pr'] as const;
export type ActedInputType = (typeof ACTED_INPUT_TYPES)[number];

/** Upper bound on loop-back iterations (§28.4): an untrusted plan-supplied slice count is clamped to this,
 *  so it can neither disable the loop (fails to 1) nor drive it unbounded (CWE-20/770). */
export const MAX_SLICES = 50;

const LOOP_BINDINGS: readonly LoopBinding[] = [...LOOP_NAMESPACES, RETIRED_LOOP_NAMESPACE];

function closed<V extends string>(values: readonly V[], docs: Readonly<Record<V, Explanation>>, extra: (value: V) => Partial<ClosedValue> = () => ({})): KeyValues {
  return { kind: 'closed', values: values.map((value) => ({ value, ...docs[value], ...extra(value) })) };
}

function acted<V extends string>(names: readonly V[], docs: Readonly<Record<V, Explanation>>): readonly ActedName[] {
  return names.map((name) => ({ name, ...docs[name] }));
}

const STEP_KIND_DOCS: Record<FlowStepKind, Explanation> = {
  manual: {
    does: 'A person produces the step’s artifact by hand; the step is done when they say so. It is never sent back for more work.',
    when: 'Choose it for work no loop automates: a review, a decision, or anything a person does at the keyboard.',
  },
  loop: {
    does: 'Runs the loop definition named by `loop` (work turn, reviews, gate) until a person or the gate authority approves it.',
    when: 'Choose it for agent work that should be reviewed and can be sent back for another round.',
  },
};

const GATE_AUTHORITY_DOCS: Record<GateAuthority, Explanation> = {
  human: {
    does: 'A person decides every gate option of the loop.',
    when: 'Choose it, or leave the key out, whenever a person should approve the artifact. It is the default.',
  },
  auto: {
    does: 'The engine takes Approve itself when the loop finishes clean; every other option, and every halt, stays with a person.',
    when: 'Choose it for a loop whose clean result needs no human sign-off.',
  },
};

const LOOP_BINDING_DOCS: Record<LoopBinding, Explanation> = {
  app: {
    does: 'Binds the loop to the app’s own loop engine, which resolves the definition through the loop lookup order.',
    when: 'Choose it, or leave the key out, for every loop step: it is the default and the only working engine.',
  },
  legacy: {
    does: 'Names the retired loop engine. The flow still loads, but this step fails with a reason when it is entered.',
    when: 'Exists only so older flow files keep loading; never choose it for a new flow.',
  },
};

const BOOTSTRAP_DOCS: Record<FlowBootstrap, Explanation> = {
  pickup: {
    does: 'On entry to the step, runs the bound loop definition’s `pickup` contract (branch, status and labels) for the step’s ticket input.',
    when: 'Choose it on the step that starts work on a ticket. It is the only bootstrap; a step bound to a definition with no `pickup` contract does not run.',
  },
};

const INPUT_TYPE_DOCS: Record<ActedInputType, Explanation> = {
  'github-ticket': {
    does: 'A GitHub issue number. The engine reads it as the run’s ticket and records the association in the run’s audit log.',
    when: 'Choose it for the input that names the ticket the flow works on.',
  },
  pr: {
    does: 'A pull-request number. The engine reads it as the run’s pull request.',
    when: 'Choose it for the input that names the pull request the flow works on.',
  },
};

export const FLOW_POSITIONS: readonly PositionCapability[] = [
  {
    definition: 'flow',
    yamlPath: '',
    unreadKeys: 'ignored',
    keys: [
      {
        key: 'name',
        does: 'The flow’s name, shown in the flow picker and the run’s records.',
        when: 'Always set it: a flow with no name, or an empty one, fails to load.',
        required: { kind: 'always' },
        rules: [],
        values: { kind: 'any' },
      },
      {
        key: 'steps',
        does: 'The flow’s steps, in the order a run moves through them.',
        when: 'Always set it to a list with at least one step; an empty or missing list fails to load.',
        required: { kind: 'always' },
        rules: [],
        values: { kind: 'any' },
      },
    ],
  },
  {
    definition: 'flow',
    yamlPath: 'steps[]',
    unreadKeys: 'ignored',
    keys: [
      {
        key: 'id',
        does: 'The step’s identifier; `repeat.back_to` and the run’s records refer to it by this value.',
        when: 'Always set it to a non-empty string.',
        required: { kind: 'always' },
        rules: [],
        values: { kind: 'any' },
      },
      {
        key: 'kind',
        does: 'What kind of step this is.',
        when: 'Always set it; any value outside the list fails to load.',
        required: { kind: 'always' },
        rules: [],
        values: closed(FLOW_STEP_KINDS, STEP_KIND_DOCS),
      },
      {
        key: 'loop',
        does: 'The name of the loop definition the step runs, resolved through the loop lookup order.',
        when: 'Set it on every `loop` step; a `manual` step ignores it.',
        required: { kind: 'conditional', condition: 'the step’s `kind` is `loop`.' },
        rules: [{ id: 'loop-step-needs-loop', text: 'A `loop` step without a non-empty `loop` fails to load.' }],
        values: { kind: 'any' },
      },
      {
        key: 'gate_authority',
        does: 'Who decides the loop’s gate.',
        when: 'Set it only to let the engine approve a clean loop; leave it out for a person to decide.',
        required: { kind: 'never' },
        rules: [{ id: 'gate-authority-only-on-loop-step', text: 'Declaring it on a step whose `kind` is not `loop` fails to load.' }],
        values: closed(GATE_AUTHORITIES, GATE_AUTHORITY_DOCS),
      },
      {
        key: 'loop_namespace',
        does: 'Which loop engine runs the step’s loop. Read on `loop` steps only.',
        when: 'Leave it out: the default binds the working engine.',
        required: { kind: 'never' },
        rules: [
          {
            id: 'app-namespace-needs-safe-loop-name',
            text: 'With `app` declared explicitly, a `loop` that is not a single safe path segment (no `/`, no `..`) fails the whole file to load.',
          },
        ],
        values: closed(LOOP_BINDINGS, LOOP_BINDING_DOCS, (b) => ({ selectsEngine: !bindsNoSurvivingEngine(b) })),
      },
      {
        key: 'skill',
        does: 'A Claude Code skill, by registered name or repository-relative file path, that the app invokes in the agent when the step is entered.',
        when: 'Set it when the agent should load a playbook for the step. It must be a string.',
        required: { kind: 'never' },
        rules: [],
        values: { kind: 'any' },
      },
      {
        key: 'todo_template',
        does: 'The to-do template the template picker selects by default for this step: the file name, with or without its extension, of one of the templates in the to-do templates folder beside the flow’s definition (see where flows and loops live).',
        when: 'Set it when the step has a checklist a person usually starts from. It must be a string.',
        required: { kind: 'never' },
        rules: [],
        values: { kind: 'any' },
      },
      {
        key: 'bootstrap',
        does: 'An action the app runs on entry to the step.',
        when: 'Set it on the step that starts work on a ticket; any other value fails to load.',
        required: { kind: 'never' },
        rules: [],
        values: closed(FLOW_BOOTSTRAPS, BOOTSTRAP_DOCS),
      },
      {
        key: 'inputs',
        does: 'The typed inputs the step declares; on entry the app prompts for each required one that has no value yet, before any `bootstrap` runs.',
        when: 'Set it on the step that first needs a ticket, a pull request, or a value such as a slice count. It must be a list.',
        required: { kind: 'never' },
        rules: [],
        values: { kind: 'any' },
      },
      {
        key: 'repeat',
        does: 'Loops the flow back: on leaving this step, the run returns to an earlier step instead of going on, a number of times read from an input.',
        when: 'Set it to run a group of steps once per slice, for example red, green and refactor for each slice of a plan.',
        required: { kind: 'never' },
        rules: [],
        values: { kind: 'any' },
      },
    ],
  },
  {
    definition: 'flow',
    yamlPath: 'steps[].inputs[]',
    unreadKeys: 'ignored',
    keys: [
      {
        key: 'name',
        does: 'The input’s name; `repeat.count_input` and the prompts refer to it.',
        when: 'Always set it to a string.',
        required: { kind: 'always' },
        rules: [],
        values: { kind: 'any' },
      },
      {
        key: 'type',
        does: 'The input’s type, which picks the prompt the app shows for it.',
        when: 'Always set it to a string; choose an acted-on type when the engine should use the value.',
        required: { kind: 'always' },
        rules: [],
        values: {
          kind: 'open',
          acted: acted(ACTED_INPUT_TYPES, INPUT_TYPE_DOCS),
          otherNames: 'Any other type loads, and the engine acts on its value only where another key names the input by `name`, as `repeat.count_input` does.',
        },
      },
      {
        key: 'required',
        does: 'Whether the step can be entered without the input. Only the value `true` makes it required; anything else is read as false.',
        when: 'Set it to `true` when the step cannot run without the value.',
        required: { kind: 'never' },
        rules: [],
        values: { kind: 'any' },
      },
    ],
  },
  {
    definition: 'flow',
    yamlPath: 'steps[].repeat',
    unreadKeys: 'ignored',
    keys: [
      {
        key: 'back_to',
        does: 'The `id` of the step the run returns to.',
        when: 'Always set it to the first step of the group to repeat.',
        required: { kind: 'always' },
        rules: [{ id: 'back-to-names-earlier-step', text: 'A `back_to` that does not name a step declared before this one (unknown, later, or this step itself) fails to load.' }],
        values: { kind: 'any' },
      },
      {
        key: 'count_input',
        does: 'The `name` of the input that holds how many times the group runs.',
        when: 'Always set it to an input a plan or a person fills with the slice count.',
        required: { kind: 'always' },
        rules: [],
        values: {
          kind: 'not-checked-at-load',
          outcomes: [
            { case: 'no-input', text: 'When no input has that name, or it has no value, the group runs once.' },
            { case: 'non-integer', text: 'When the value is not a whole number, the group runs once.' },
            { case: 'below-one', text: 'When the value is below 1, the group runs once.' },
            { case: 'above-cap', text: `When the value is above ${MAX_SLICES}, the group runs ${MAX_SLICES} times.` },
          ],
        },
      },
    ],
  },
];
