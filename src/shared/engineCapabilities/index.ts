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
  positions: [],
  lookupOrder: [],
  sectionTitles: { 'where-things-live': '', 'lookup-order': '' },
  markers: {
    required: { always: '', never: '', conditional: '' },
    unreadKeys: { rejected: '', ignored: '' },
    notCheckedAtLoad: '',
    selectsEngine: { yes: '', no: '' },
  },
};
