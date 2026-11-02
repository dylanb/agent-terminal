import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { ENGINE_CAPABILITIES, type KeyCapability, type PositionCapability } from '../../src/shared/engineCapabilities';
import { FLOW_DEF_FILE, loadFlowDefinitionFromFile } from '../../src/main/flow';
import { resolveExampleFlowsDir } from '../../src/main/exampleAssets';
import { resolveLoopDefV2 } from '../../src/main/loopDefV2';
import {
  CLOSED_SETS,
  CROSS_FIELD_RULES,
  FLOW_POSITIONS,
  LOOKUP_ORDER,
  NOT_CHECKED_AT_LOAD,
  OPEN_SETS,
  type FlowKeyOf,
  type FlowPositionId,
  type TierId,
} from '../helpers/engineCapabilityOracle';
import {
  FLOW_REQUIRED_ONLY_VALUES,
  FLOW_SAMPLES,
  SAMPLE_LOOP,
  flowFields,
  flowWith,
  loadFlowDoc,
  loadWithValue,
  plantLoopInTiers,
} from '../helpers/capabilityDefs';

const SLICE = 1 as const;
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FLOW_POSITION_IDS = Object.keys(FLOW_POSITIONS) as FlowPositionId[];

const positionIdOf = (p: PositionCapability): string => (p.yamlPath === '' ? p.definition : `${p.definition}.${p.yamlPath}`);
const descriptorPosition = (id: string): PositionCapability | undefined => ENGINE_CAPABILITIES.positions.find((p) => positionIdOf(p) === id);
const descriptorKey = (id: string, key: string): KeyCapability | undefined => descriptorPosition(id)?.keys.find((k) => k.key === key);
const sorted = (values: readonly unknown[]): string[] => values.map(String).sort();

/** The value-set kind the oracle records for a key: a closed set, an open set, not checked at load, or any value. */
function oracleValuesKind(position: string, key: string): KeyCapability['values']['kind'] {
  const at = (k: { position: string; key: string }) => k.position === position && k.key === key;
  if (CLOSED_SETS.some(at)) return 'closed';
  if (Object.values(OPEN_SETS).some(at)) return 'open';
  if (NOT_CHECKED_AT_LOAD.some(at)) return 'not-checked-at-load';
  return 'any';
}

/** The descriptor's keys at a flow position that have a sample, typed as the position's keys. */
function descriptorFlowKeys<P extends FlowPositionId>(problems: string[], id: P, which: (k: KeyCapability) => boolean): FlowKeyOf<P>[] | undefined {
  const position = descriptorPosition(id);
  if (position === undefined) {
    problems.push(`${id}: not in the descriptor`);
    return undefined;
  }
  const samples: Readonly<Record<string, unknown>> = FLOW_SAMPLES[id];
  const keys = position.keys.filter(which).map((k) => k.key);
  for (const key of keys.filter((k) => !(k in samples))) problems.push(`${id} ${key}: the descriptor lists a key the loader has no sample for`);
  return keys.filter((k): k is FlowKeyOf<P> => k in samples);
}

describe('the descriptor matches the flow loader as the oracle records it (#276 D3)', () => {
  it('lists each flow position with the oracle’s keys, required flags and unread-key mode', () => {
    const descriptorFlow = ENGINE_CAPABILITIES.positions.filter((p) => p.definition === 'flow').map(positionIdOf);
    const actual = Object.fromEntries(
      FLOW_POSITION_IDS.map((id) => {
        const p = descriptorPosition(id);
        return [
          id,
          p === undefined ? null : { unreadKeys: p.unreadKeys, keys: Object.fromEntries(p.keys.map((k) => [k.key, { required: k.required.kind, values: k.values.kind }])) },
        ];
      }),
    );
    const expected = Object.fromEntries(
      FLOW_POSITION_IDS.map((id) => [
        id,
        {
          unreadKeys: FLOW_POSITIONS[id].unreadKeys,
          keys: Object.fromEntries(Object.entries(FLOW_POSITIONS[id].keys).map(([key, required]) => [key, { required, values: oracleValuesKind(id, key) }])),
        },
      ]),
    );
    expect({ positions: descriptorFlow.sort(), byPosition: actual }).toEqual({ positions: [...FLOW_POSITION_IDS].sort(), byPosition: expected });
  });

  it('lists the oracle’s values for each flow closed set, and the loader accepts each and rejects an unlisted one', () => {
    const problems: string[] = [];
    for (const set of CLOSED_SETS.filter((s) => s.slice <= SLICE)) {
      const where = `${set.position} ${set.key}`;
      const key = descriptorKey(set.position, set.key);
      const listed = key?.values.kind === 'closed' ? key.values.values.map((v) => v.value) : [];
      if (JSON.stringify(sorted(listed)) !== JSON.stringify(sorted(set.values))) {
        problems.push(`${where}: the descriptor lists ${JSON.stringify(sorted(listed))}, the loader accepts ${JSON.stringify(sorted(set.values))}`);
      }
      for (const value of listed) if (!loadWithValue(set, value).ok) problems.push(`${where}: the loader rejects listed ${String(value)}`);
      if (loadWithValue(set, 'not-a-listed-value').ok) problems.push(`${where}: the loader accepts an unlisted value`);
    }
    expect(problems).toEqual([]);
  });

  it('lists the oracle’s acted-on input types and marks the keys not checked at load', () => {
    const { position, key, acted } = OPEN_SETS.inputType;
    const inputType = descriptorKey(position, key);
    const notChecked = NOT_CHECKED_AT_LOAD.filter((k) => k.slice <= SLICE).map((k) => descriptorKey(k.position, k.key)?.values.kind ?? null);
    expect({
      actedInputTypes: inputType?.values.kind === 'open' ? sorted(inputType.values.acted.map((a) => a.name)) : null,
      notCheckedAtLoad: notChecked,
    }).toEqual({ actedInputTypes: sorted(acted), notCheckedAtLoad: notChecked.map(() => 'not-checked-at-load') });
  });

  it('loads an input of a type the engine does not act on, which it ignores', () => {
    const fields = flowFields('flow.steps[].inputs[]', ['name', 'type'], { type: 'not-an-acted-type' });
    expect(loadFlowDoc(flowWith('flow.steps[].inputs[]', fields)).ok).toBe(true);
  });

  it('attaches the oracle’s cross-field rules to each flow key, and a definition breaking each rule fails to load', () => {
    type SliceRule = Extract<(typeof CROSS_FIELD_RULES)[number], { slice: typeof SLICE }>;
    const rules = CROSS_FIELD_RULES.filter((r): r is SliceRule => r.slice <= SLICE);
    const actual = FLOW_POSITION_IDS.flatMap((id) => (descriptorPosition(id)?.keys ?? []).flatMap((k) => k.rules.map((r) => `${id} ${k.key} ${r.id}`)));
    const breaking: Record<SliceRule['rule'], Record<string, unknown>> = {
      'loop-step-needs-loop': flowWith('flow.steps[]', { id: 'second', kind: 'loop' }),
      'gate-authority-only-on-loop-step': flowWith('flow.steps[]', { id: 'second', kind: 'manual', gate_authority: 'human' }),
      'app-namespace-needs-safe-loop-name': flowWith('flow.steps[]', { id: 'second', kind: 'loop', loop: '../escape', loop_namespace: 'app' }),
      'back-to-names-earlier-step': flowWith('flow.steps[]', { id: 'second', kind: 'manual', repeat: { back_to: 'second', count_input: 'slices' } }),
    };
    expect({
      rules: actual.sort(),
      loadsAnyway: rules.filter((r) => loadFlowDoc(breaking[r.rule]).ok).map((r) => r.rule),
    }).toEqual({ rules: rules.map((r) => `${r.position} ${r.key} ${r.rule}`).sort(), loadsAnyway: [] });
  });

  it('loads a definition with only each flow position’s always-required keys, and fails without any one of them', () => {
    const problems: string[] = [];
    for (const id of FLOW_POSITION_IDS) {
      const keys = descriptorFlowKeys(problems, id, (k) => k.required.kind === 'always');
      if (keys === undefined) continue;
      const values = FLOW_REQUIRED_ONLY_VALUES[id];
      const load = (subset: typeof keys) => loadFlowDoc(flowWith(id, flowFields(id, subset, values)));
      if (!load(keys).ok) problems.push(`${id}: the always-required keys alone do not load`);
      for (const key of keys) if (load(keys.filter((k) => k !== key)).ok) problems.push(`${id}: loads without always-required ${key}`);
    }
    expect(problems).toEqual([]);
  });

  it('loads a key the flow loader does not read at each position the descriptor marks it ignored', () => {
    const problems: string[] = [];
    for (const id of FLOW_POSITION_IDS) {
      const position = descriptorPosition(id);
      const keys = descriptorFlowKeys(problems, id, () => true);
      if (position === undefined || keys === undefined) continue;
      const loads = loadFlowDoc(flowWith(id, { ...flowFields(id, keys), not_a_read_key: 'x' })).ok;
      if (loads !== (position.unreadKeys === 'ignored')) problems.push(`${id}: an unread key ${loads ? 'loads' : 'fails'} where the descriptor says ${position.unreadKeys}`);
    }
    expect(problems).toEqual([]);
  });
});

describe('every key the descriptor lists at a flow position loads together (#276 D4)', () => {
  it('loads one definition per flow position that uses every key listed there', () => {
    const problems: string[] = [];
    for (const id of FLOW_POSITION_IDS) {
      const keys = descriptorFlowKeys(problems, id, () => true);
      if (keys === undefined) continue;
      const load = loadFlowDoc(flowWith(id, flowFields(id, keys)));
      if (!load.ok) problems.push(`${id}: ${load.error}`);
    }
    expect(problems).toEqual([]);
  });
});

describe('the descriptor’s lookup order is the order the loop resolver uses (#276 G5)', () => {
  /** The tiers in the order `resolveLoopDefV2` prefers them: plant the loop in every remaining tier, take the one it resolves to. */
  function resolverOrder(): TierId[] {
    const order: TierId[] = [];
    let remaining: TierId[] = [...LOOKUP_ORDER];
    while (remaining.length > 0) {
      const planted = plantLoopInTiers(remaining);
      try {
        const resolved = resolveLoopDefV2(SAMPLE_LOOP, planted.ctx);
        const winner = resolved.ok ? remaining.find((t) => planted.defDirOf(t) === resolved.defDir) : undefined;
        if (winner === undefined) throw new Error(`resolving among ${remaining.join(', ')} matched no planted tier`);
        order.push(winner);
        remaining = remaining.filter((t) => t !== winner);
      } finally {
        planted.dispose();
      }
    }
    return order;
  }

  it('lists the tiers in the order a loop name resolves through them', () => {
    expect(ENGINE_CAPABILITIES.lookupOrder.map((t) => t.tier)).toEqual(resolverOrder());
  });
});

describe('every bundled flow definition loads (#276 B1)', () => {
  it('loads each flow.yaml in the bundled flow catalog', () => {
    const catalog = resolveExampleFlowsDir({ packaged: false, appPath: REPO_ROOT });
    const flows = readdirSync(catalog, { withFileTypes: true }).filter((e) => e.isDirectory());
    const failed = flows.flatMap((e) => {
      const load = loadFlowDefinitionFromFile(path.join(catalog, e.name, FLOW_DEF_FILE));
      return load.ok ? [] : [`${e.name}: ${load.error}`];
    });
    expect({ flows: flows.length > 1, failed }).toEqual({ flows: true, failed: [] });
  });
});
