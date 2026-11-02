import { FLOW_POSITIONS } from './flow';

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

export interface KeyCapability extends Explanation {
  key: string;
  required: KeyRequirement;
  rules: readonly CrossFieldRule[];
  values: KeyValues;
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

export type GuideSection = 'where-things-live' | 'lookup-order';

export interface EngineCapabilities {
  title: string;
  intro: string;
  definitionTitles: Readonly<Record<Definition, string>>;
  positions: readonly PositionCapability[];
  lookupOrder: readonly LookupTier[];
  sectionTitles: Readonly<Record<GuideSection, string>>;
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
    'What the engine accepts in a flow definition, and where flows and loops live. Generated from the definitions the engine itself loads, so it always matches the app that installed it.',
  definitionTitles: { flow: 'Flow definitions', loop: 'Loop definitions' },
  positions: [...FLOW_POSITIONS],
  lookupOrder: [
    { tier: 'repo-override', text: 'The repository’s loop override file, when its map names the loop.' },
    { tier: 'flow-folder-operator', text: 'The operator tier’s folder named after the running flow’s `name`.' },
    { tier: 'flow-folder-app-bundled', text: 'The app-bundled tier’s folder named after the running flow’s `name`.' },
    { tier: 'operator', text: 'The shared operator tier, outside any flow folder.' },
    { tier: 'app-bundled', text: 'The shared app-bundled tier, outside any flow folder.' },
  ],
  sectionTitles: { 'where-things-live': 'Where flows and loops live', 'lookup-order': 'How a loop name resolves' },
  markers: {
    required: { always: '**Required.**', never: '**Optional.**', conditional: '**Required when**' },
    unreadKeys: { rejected: 'A key not listed here fails the definition to load.', ignored: 'A key not listed here is ignored.' },
    notCheckedAtLoad: 'Not checked when the definition loads; at run time:',
    selectsEngine: { yes: 'Selects a working engine.', no: 'Selects no working engine.' },
  },
};
