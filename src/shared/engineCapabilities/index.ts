import type { LoopCapabilitiesKey } from '../loopCapabilities';
import type { TurnKind } from '../loopTurn';
import { FLOW_POSITIONS } from './flow';
import { LOOP_POSITIONS } from './loop';

export interface Explanation {
  does: string;
  when: string;
}

export type KeyRequirement = { kind: 'always' } | { kind: 'never' } | { kind: 'conditional'; condition: string };

export interface ClosedValue extends Explanation {
  value: string | boolean;
  /** Set only on a value that chooses the engine a step runs on. */
  selectsEngine?: boolean;
}

export interface ActedName extends Explanation {
  name: string;
  /** The args the engine reads beside this name: a side-effect kind's keys other than `kind`. */
  args?: readonly KeyCapability[];
}

export interface RunTimeOutcome {
  case: string;
  text: string;
}

export type KeyValues =
  | { kind: 'any' }
  | { kind: 'closed'; values: readonly ClosedValue[] }
  | { kind: 'open'; acted: readonly ActedName[]; otherNames: string }
  | { kind: 'not-checked-at-load'; outcomes: readonly RunTimeOutcome[] };

export interface CrossFieldRule {
  id: string;
  text: string;
}

/** What the engine does with a `{…}` slot in the key's value. */
export type SlotBehaviour = { kind: 'rejected' } | { kind: 'expanded'; slot: string };

export interface KeyCapability extends Explanation {
  key: string;
  required: KeyRequirement;
  rules: readonly CrossFieldRule[];
  values: KeyValues;
  slots?: SlotBehaviour;
}

export type Definition = 'flow' | 'loop';

export interface PositionCapability {
  definition: Definition;
  /** '' is the definition's top level. */
  yamlPath: string;
  unreadKeys: 'rejected' | 'ignored';
  keys: readonly KeyCapability[];
}

export interface LookupTier {
  tier: string;
  text: string;
}

/** What each fixed part of the turn contract does, for an agent writing a brief, recipe or charter. */
export interface TurnContract {
  intro: string;
  marker: string;
  doneFile: string;
  turnKeys: Readonly<Record<TurnKind, string>>;
  capabilitiesFile: string;
  capabilitiesKeys: Readonly<Record<LoopCapabilitiesKey, string>>;
  slotExpanded: string;
  slotRejected: string;
}

export type GuideSection = 'where-things-live' | 'lookup-order' | 'turn-contract' | 'turn-composition';

export interface EngineCapabilities {
  title: string;
  intro: string;
  definitionTitles: Readonly<Record<Definition, string>>;
  positions: readonly PositionCapability[];
  lookupOrder: readonly LookupTier[];
  sectionTitles: Readonly<Record<GuideSection, string>>;
  turnContract: TurnContract;
  /** How a loop's brief, work recipe and reviewer charters become the turns the engine runs. */
  turnComposition: string;
  markers: {
    required: Readonly<Record<KeyRequirement['kind'], string>>;
    unreadKeys: Readonly<Record<PositionCapability['unreadKeys'], string>>;
    notCheckedAtLoad: string;
    selectsEngine: Readonly<Record<'yes' | 'no', string>>;
  };
}

export const ENGINE_CAPABILITIES: EngineCapabilities = {
  title: 'Agent Terminal engine capabilities',
  intro:
    'What the engine accepts in a flow definition and a loop definition, where flows and loops live, and the contract a loop’s turns follow. Generated from the definitions the engine itself loads, so it always matches the app that installed it.',
  definitionTitles: { flow: 'Flow definitions', loop: 'Loop definitions' },
  positions: [...FLOW_POSITIONS, ...LOOP_POSITIONS],
  lookupOrder: [
    { tier: 'repo-override', text: 'The repository’s loop override file, when its map names the loop.' },
    { tier: 'flow-folder-operator', text: 'The operator tier’s folder named after the running flow’s `name`.' },
    { tier: 'flow-folder-app-bundled', text: 'The app-bundled tier’s folder named after the running flow’s `name`.' },
    { tier: 'operator', text: 'The shared operator tier, outside any flow folder.' },
    { tier: 'app-bundled', text: 'The shared app-bundled tier, outside any flow folder.' },
  ],
  sectionTitles: {
    'where-things-live': 'Where flows and loops live',
    'lookup-order': 'How a loop name resolves',
    'turn-contract': 'The turn contract',
    'turn-composition': 'How briefs, recipes and charters become turns',
  },
  turnContract: {
    intro:
      'What the engine and an agent running a loop step agree on: the lines and files a turn writes, the file a repository describes its tests in, and the `{…}` slots a definition may hold.',
    marker:
      'The marker line a work turn that produces a file writes as the last line of that file, with the step id in place of `<step>`. The engine counts the file as produced only when it holds this line.',
    doneFile:
      'The file a turn writes as its very last action, holding only its turn key. Writing it is what ends the turn; anything the agent prints is ignored.',
    turnKeys: {
      work: 'The turn key of a step’s work turn, with the step id in place of `<step>`.',
      review: 'The turn key of a step’s review-and-fix turn.',
      consolidate: 'The turn key of a step’s consolidating turn.',
    },
    capabilitiesFile:
      'The file at the repository root that describes the repository’s tests to the RED, GREEN and REFACTOR steps. A key not listed here fails the file.',
    capabilitiesKeys: {
      test_globs: 'The globs naming the repository’s test files. The engine matches changed files against them to tell whether a turn added or changed a test.',
      test_command: 'The command that runs the tests. The engine never runs it; a recipe tells the agent to.',
      build_command: 'The command that builds the app. The engine never runs it; a recipe tells the agent to.',
      select_template: 'Checked when the file is read, and otherwise unused by the engine.',
      red_check_command:
        'The command a RED turn is told to run to check that each test it added fails as intended, writing a red-check report. When it is set, the engine accepts the RED step only when that report is present and verifies. Without it, the RED step completes unchecked and is recorded as not independently checked.',
    },
    slotExpanded: 'The engine replaces this slot with the ticket number before it uses the value.',
    slotRejected:
      'A `{…}` slot is never expanded in these places, so a definition with one in any of them fails to load:',
  },
  turnComposition: [
    'A loop step runs as turns, each one prompt the engine types into the agent’s session and one done-signal file the agent writes back.',
    '',
    '- **Work turn.** The prompt is the loop’s `brief`, when it has one, followed by the `work.recipe` file’s body. The engine then adds what the run knows: the ticket the loop works, the paths of the step’s inputs, the report section the step writes, and the instruction to end the produced file with the marker line and to write the done-signal file last.',
    '- **Review-and-fix turn.** The agent runs each reviewer in `reviewers[]` as a sub-agent installed from that reviewer’s `charter`, so the charter is the reviewer’s whole instructions. The engine hands every reviewer the same short hand-off naming the ticket and the inputs, and the agent fixes or dismisses what they find. The loop’s `brief`, when it has one, follows as standing instructions every fix must meet; a step in it that only the work turn takes, such as interviewing the operator, does not run again there.',
    '- **Consolidating turn.** When the loop has a `consolidator`, its `recipe` body, with the last two rounds’ reports, decides whether another round runs.',
    '- **Goal loops.** When `work.goal` is set, one goal session does the work and the reviews together, in legs when `work.checkpoint` is set, and records its progress in a file the engine reads to decide when the step is done.',
    '',
    'Brief, recipe and charter files are read as written: the engine adds its own instructions around them and never edits them.',
  ].join('\n'),
  markers: {
    required: { always: '**Required.**', never: '**Optional.**', conditional: '**Required when**' },
    unreadKeys: { rejected: 'A key not listed here fails the definition to load.', ignored: 'A key not listed here is ignored.' },
    notCheckedAtLoad: 'Not checked when the definition loads; at run time:',
    selectsEngine: { yes: 'Selects a working engine.', no: 'Selects no working engine.' },
  },
};
