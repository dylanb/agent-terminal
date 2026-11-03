import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ENGINE_CAPABILITIES, type KeyCapability, type PositionCapability } from '../../src/shared/engineCapabilities';
import { loadFlowDefinitionFromFile } from '../../src/main/flow';
import { resolveExampleFlowsDir, resolveExampleLoopsV2Dir } from '../../src/main/exampleAssets';
import { resolveLoopDefV2 } from '../../src/main/loopDefV2';
import { parseLoopCapabilities } from '../../src/shared/loopCapabilities';
import {
  CLOSED_SETS,
  CROSS_FIELD_RULES,
  LOOKUP_ORDER,
  LOOP_CAPABILITIES_KEYS,
  LOOP_LAYOUT,
  NOT_CHECKED_AT_LOAD,
  OPEN_SETS,
  POSITIONS,
  SIDE_EFFECT_ARGS,
  SLOT_EXPANDING,
  SLOT_REJECTING,
  positionKeys,
  type Definition,
  type OpenSet,
  type OracleRuleId,
  type PositionId,
  type TierId,
} from '../helpers/engineCapabilityOracle';
import {
  LOOP_BASE,
  LOOP_SAMPLES,
  SAMPLE_LOOP,
  fieldsAt,
  loadAt,
  loadWithValue,
  plantLoopInTiers,
  requiredOnlyValuesAt,
  samplesAt,
  withSlot,
  type DefLoad,
} from '../helpers/capabilityDefs';
import {
  descriptorActed,
  descriptorKey as descriptorKeyIn,
  descriptorOpenSet,
  descriptorPosition as descriptorPositionIn,
  positionIdOf,
} from '../helpers/descriptorEntries';
import { FLOW_DEF_FILE } from '../../src/main/flowHome';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OPEN_SET_LIST: readonly OpenSet[] = Object.values(OPEN_SETS);

const descriptorPosition = (id: string): PositionCapability | undefined => descriptorPositionIn(ENGINE_CAPABILITIES, id);
const descriptorKey = (id: string, key: string): KeyCapability | undefined => descriptorKeyIn(ENGINE_CAPABILITIES, id, key);
const sorted = (values: readonly unknown[]): string[] => values.map(String).sort();
const positionIds = (d: Definition): PositionId[] => (Object.keys(POSITIONS) as PositionId[]).filter((id) => POSITIONS[id].definition === d);
const ofDefinition = (d: Definition) => (s: { position: PositionId }) => POSITIONS[s.position].definition === d;

/** The value-set kind the oracle records for a key: a closed set, an open set, not checked at load, or any value. */
function oracleValuesKind(position: string, key: string): KeyCapability['values']['kind'] {
  const at = (k: { position: string; key: string }) => k.position === position && k.key === key;
  if (CLOSED_SETS.some(at)) return 'closed';
  if (Object.values(OPEN_SETS).some(at)) return 'open';
  if (NOT_CHECKED_AT_LOAD.some(at)) return 'not-checked-at-load';
  return 'any';
}

/** The descriptor's keys at a position that have a sample. */
function descriptorKeys(problems: string[], id: PositionId, which: (k: KeyCapability) => boolean): string[] | undefined {
  const position = descriptorPosition(id);
  if (position === undefined) {
    problems.push(`${id}: not in the descriptor`);
    return undefined;
  }
  const samples = samplesAt(id);
  const keys = position.keys.filter(which).map((k) => k.key);
  for (const key of keys.filter((k) => !(k in samples))) problems.push(`${id} ${key}: the descriptor lists a key the loader has no sample for`);
  return keys.filter((k) => k in samples);
}

const sideEffect = (fields: Record<string, unknown>) => loadAt('loop.gate[].side_effects[]', fields);
const workWith = (keys: readonly string[], values: Record<string, unknown> = {}) => fieldsAt('loop.work', keys, values);

/** For each cross-field rule, a definition that breaks only it, and the same definition with the break mended. */
const RULE_CASES: Readonly<Record<OracleRuleId, { breaks: () => DefLoad; mended: () => DefLoad }>> = {
  'loop-step-needs-loop': {
    breaks: () => loadAt('flow.steps[]', { id: 'second', kind: 'loop' }),
    mended: () => loadAt('flow.steps[]', { id: 'second', kind: 'loop', loop: 'plan-loop' }),
  },
  'gate-authority-only-on-loop-step': {
    breaks: () => loadAt('flow.steps[]', { id: 'second', kind: 'manual', gate_authority: 'human' }),
    mended: () => loadAt('flow.steps[]', { id: 'second', kind: 'loop', loop: 'plan-loop', gate_authority: 'human' }),
  },
  'app-namespace-needs-safe-loop-name': {
    breaks: () => loadAt('flow.steps[]', { id: 'second', kind: 'loop', loop: '../escape', loop_namespace: 'app' }),
    mended: () => loadAt('flow.steps[]', { id: 'second', kind: 'loop', loop: 'plan-loop', loop_namespace: 'app' }),
  },
  'back-to-names-earlier-step': {
    breaks: () => loadAt('flow.steps[]', { id: 'second', kind: 'manual', repeat: { back_to: 'second', count_input: 'slices' } }),
    mended: () => loadAt('flow.steps[]', { id: 'second', kind: 'manual', repeat: { back_to: 'first', count_input: 'slices' } }),
  },
  'declared-name-matches-resolved-name': {
    breaks: () => loadAt('loop', { ...LOOP_BASE, name: `not-${SAMPLE_LOOP}` }),
    mended: () => loadAt('loop', { ...LOOP_BASE, name: SAMPLE_LOOP }),
  },
  'goal-excludes-consolidator': {
    breaks: () => loadAt('loop', { ...LOOP_BASE, work: workWith(['recipe', 'artifact', 'goal']), consolidator: LOOP_SAMPLES['loop.consolidator'] }),
    mended: () => loadAt('loop', { ...LOOP_BASE, work: workWith(['recipe', 'artifact']), consolidator: LOOP_SAMPLES['loop.consolidator'] }),
  },
  'reviewers-need-consolidator-or-goal': {
    breaks: () => loadAt('loop', { ...LOOP_BASE, reviewers: [LOOP_SAMPLES['loop.reviewers[]']] }),
    mended: () => loadAt('loop', { ...LOOP_BASE, reviewers: [LOOP_SAMPLES['loop.reviewers[]']], consolidator: LOOP_SAMPLES['loop.consolidator'] }),
  },
  'result-completion-needs-artifact-output': {
    breaks: () => loadAt('loop.work', workWith(['recipe', 'artifact', 'completion'], { artifact: 'not-an-output' })),
    mended: () => loadAt('loop.work', workWith(['recipe', 'artifact', 'completion'])),
  },
  'checkpoint-needs-goal': {
    breaks: () => loadAt('loop.work', workWith(['recipe', 'artifact', 'checkpoint'])),
    mended: () => loadAt('loop.work', workWith(['recipe', 'artifact', 'goal', 'checkpoint'])),
  },
  'request-changes-needs-review-rounds': {
    breaks: () => loadAt('loop', { ...LOOP_BASE, gate: [{ option: 'request-changes' }] }),
    mended: () => loadAt('loop', { ...LOOP_BASE, gate: [{ option: 'request-changes' }], reviewers: [], consolidator: LOOP_SAMPLES['loop.consolidator'] }),
  },
  'compact-needs-message': {
    breaks: () => loadAt('loop.boundaries[]', { boundary: 'pre-work', mode: 'compact' }),
    mended: () => loadAt('loop.boundaries[]', { boundary: 'pre-work', mode: 'compact', message: 'Keep the plan.' }),
  },
  'id-declared-once': {
    breaks: () => loadAt('loop', { ...LOOP_BASE, outputs: [{ id: 'plan', path: 'plan.md' }, { id: 'plan', path: 'other.md' }] }),
    mended: () => loadAt('loop', { ...LOOP_BASE, outputs: [{ id: 'plan', path: 'plan.md' }, { id: 'other', path: 'other.md' }] }),
  },
};

describe.each(['flow', 'loop'] as const)('the descriptor matches the %s loader as the oracle records it (#276 D3)', (definition) => {
  const ids = positionIds(definition);

  it('lists each position with the oracle’s keys, required flags, value-set kinds and unread-key mode', () => {
    const listed = ENGINE_CAPABILITIES.positions.filter((p) => p.definition === definition).map(positionIdOf);
    const actual = Object.fromEntries(
      ids.map((id) => {
        const p = descriptorPosition(id);
        return [
          id,
          p === undefined ? null : { unreadKeys: p.unreadKeys, keys: Object.fromEntries(p.keys.map((k) => [k.key, { required: k.required.kind, values: k.values.kind }])) },
        ];
      }),
    );
    const expected = Object.fromEntries(
      ids.map((id) => [
        id,
        {
          unreadKeys: POSITIONS[id].unreadKeys,
          keys: Object.fromEntries(Object.entries(POSITIONS[id].keys).map(([key, required]) => [key, { required, values: oracleValuesKind(id, key) }])),
        },
      ]),
    );
    expect({ positions: listed.sort(), byPosition: actual }).toEqual({ positions: [...ids].sort(), byPosition: expected });
  });

  it('lists the oracle’s values for each closed set, and the loader accepts each and rejects an unlisted one', () => {
    const problems: string[] = [];
    for (const set of CLOSED_SETS.filter(ofDefinition(definition))) {
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

  it('lists the oracle’s acted-on names for each open set', () => {
    const sets = OPEN_SET_LIST.filter(ofDefinition(definition));
    const listed = (set: OpenSet): string[] | null => {
      const values = descriptorOpenSet(ENGINE_CAPABILITIES, set);
      return values?.kind === 'open' ? sorted(values.acted.map((a) => a.name)) : null;
    };
    expect(sets.map((s) => ({ key: s.key, acted: listed(s) }))).toEqual(sets.map((s) => ({ key: s.key, acted: sorted(s.acted) })));
  });

  it('attaches the oracle’s cross-field rules to each key, and a definition breaking each rule fails to load', () => {
    const rules = CROSS_FIELD_RULES.filter(ofDefinition(definition));
    const actual = ids.flatMap((id) => (descriptorPosition(id)?.keys ?? []).flatMap((k) => k.rules.map((r) => `${id} ${k.key} ${r.id}`)));
    expect({
      rules: actual.sort(),
      loadsAnyway: rules.filter((r) => RULE_CASES[r.rule].breaks().ok).map((r) => r.rule),
      mendedFails: rules.flatMap((r) => {
        const mended = RULE_CASES[r.rule].mended();
        return mended.ok ? [] : [`${r.rule}: ${mended.reason}`];
      }),
    }).toEqual({ rules: rules.map((r) => `${r.position} ${r.key} ${r.rule}`).sort(), loadsAnyway: [], mendedFails: [] });
  });

  it('loads a definition with only each position’s always-required keys, and fails without any one of them', () => {
    const problems: string[] = [];
    for (const id of ids) {
      const keys = descriptorKeys(problems, id, (k) => k.required.kind === 'always');
      if (keys === undefined) continue;
      const load = (subset: readonly string[]) => loadAt(id, fieldsAt(id, subset, requiredOnlyValuesAt(id)));
      const alone = load(keys);
      if (!alone.ok) problems.push(`${id}: the always-required keys alone do not load: ${alone.reason}`);
      for (const key of keys) if (load(keys.filter((k) => k !== key)).ok) problems.push(`${id}: loads without always-required ${key}`);
    }
    expect(problems).toEqual([]);
  });

  it('fails a key the loader does not read exactly where the descriptor marks it rejected, and loads it elsewhere', () => {
    const problems: string[] = [];
    for (const id of ids) {
      const position = descriptorPosition(id);
      const keys = descriptorKeys(problems, id, () => true);
      if (position === undefined || keys === undefined) continue;
      const loads = loadAt(id, { ...fieldsAt(id, keys), not_a_read_key: 'x' }).ok;
      if (loads !== (position.unreadKeys === 'ignored')) problems.push(`${id}: an unread key ${loads ? 'loads' : 'fails'} where the descriptor says ${position.unreadKeys}`);
    }
    expect(problems).toEqual([]);
  });
});

describe.each(['flow', 'loop'] as const)('every key the descriptor lists at a %s position loads together (#276 D4)', (definition) => {
  it('loads one definition per position that uses every key listed there', () => {
    const problems: string[] = [];
    for (const id of positionIds(definition)) {
      const keys = descriptorKeys(problems, id, () => true);
      if (keys === undefined) continue;
      const load = loadAt(id, fieldsAt(id, keys));
      if (!load.ok) problems.push(`${id}: ${load.reason}`);
    }
    expect(problems).toEqual([]);
  });
});

describe('the flow loader’s open values (#276 D3)', () => {
  it('marks the keys not checked at load', () => {
    const notChecked = NOT_CHECKED_AT_LOAD.filter(ofDefinition('flow')).map((k) => descriptorKey(k.position, k.key)?.values.kind ?? null);
    expect(notChecked).toEqual(notChecked.map(() => 'not-checked-at-load'));
  });

  it('loads an input of a type the engine does not act on, which it ignores', () => {
    expect(loadAt('flow.steps[].inputs[]', fieldsAt('flow.steps[].inputs[]', ['name', 'type'], { type: 'not-an-acted-type' })).ok).toBe(true);
  });
});

describe('the loop loader’s open values (#276 D3)', () => {
  it('lists the oracle’s args for each side-effect kind the engine acts on', () => {
    const { position, key, acted } = OPEN_SETS.sideEffectKind;
    const args = (kind: string): string[] | null => {
      const named = descriptorActed(ENGINE_CAPABILITIES, position, key, kind);
      return named === undefined ? null : sorted((named.args ?? []).map((a) => a.key));
    };
    expect(Object.fromEntries(acted.map((kind) => [kind, args(kind)]))).toEqual(
      Object.fromEntries(acted.map((kind) => [kind, sorted(SIDE_EFFECT_ARGS[kind])])),
    );
  });

  it('fails a side effect without an arg exactly where the descriptor marks that arg always required', () => {
    const { position, key, acted } = OPEN_SETS.sideEffectKind;
    const problems = acted.flatMap((kind) =>
      (descriptorActed(ENGINE_CAPABILITIES, position, key, kind)?.args ?? [])
        .filter((arg) => arg.required.kind === 'always' && sideEffect({ kind }).ok)
        .map((arg) => `${kind} ${arg.key}: marked always required, but a ${kind} side effect without it loads`),
    );
    expect(problems).toEqual([]);
  });

  it('loads a gate option, a side-effect kind and a gh action the engine does not act on, and refuses each load-rejected kind', () => {
    const loadRejected = OPEN_SETS.sideEffectKind.loadRejected;
    expect({
      gateOption: loadAt('loop.gate[]', { option: 'not-an-acted-option' }).ok,
      sideEffectKind: sideEffect({ kind: 'not-an-acted-kind' }).ok,
      ghAction: sideEffect({ kind: 'gh', action: 'not-an-acted-action' }).ok,
      loadRejectedLoads: loadRejected.filter((kind) => sideEffect({ kind }).ok),
    }).toEqual({ gateOption: true, sideEffectKind: true, ghAction: true, loadRejectedLoads: [] });
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

describe('every bundled definition loads (#276 B1)', () => {
  it('loads each flow.yaml in the bundled flow catalog', () => {
    const catalog = resolveExampleFlowsDir({ packaged: false, appPath: REPO_ROOT });
    const flows = readdirSync(catalog, { withFileTypes: true }).filter((e) => e.isDirectory());
    const failed = flows.flatMap((e) => {
      const load = loadFlowDefinitionFromFile(path.join(catalog, e.name, FLOW_DEF_FILE));
      return load.ok ? [] : [`${e.name}: ${load.error}`];
    });
    expect({ flows: flows.length > 1, failed }).toEqual({ flows: true, failed: [] });
  });

  it('resolves each loop definition in the bundled loop tree from its own folder, whether or not a flow binds it', () => {
    const tree = resolveExampleLoopsV2Dir({ packaged: false, appPath: REPO_ROOT });
    const dirs = (root: string): string[] => readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    const isLoopDir = (root: string, name: string): boolean => existsSync(path.join(root, LOOP_LAYOUT.defRelPath(name)));
    const loops: { name: string; flow?: string; root: string }[] = dirs(tree).flatMap((d) =>
      isLoopDir(tree, d) ? [{ name: d, root: tree }] : dirs(path.join(tree, d)).filter((n) => isLoopDir(path.join(tree, d), n)).map((name) => ({ name, flow: d, root: path.join(tree, d) })),
    );
    const repoDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'capability-bundled-repo-')));
    try {
      const failed = loops.flatMap(({ name, flow, root }) => {
        const r = resolveLoopDefV2(name, { tiers: { operator: null, appBundled: tree, retired: null }, repoDir, ...(flow === undefined ? {} : { flow }) });
        if (!r.ok) return [`${flow ?? '(shared)'}/${name}: ${r.reason}`];
        return r.defDir === path.join(root, name) ? [] : [`${flow ?? '(shared)'}/${name}: resolved to ${r.defDir}`];
      });
      expect({ loops: loops.length > 1, failed }).toEqual({ loops: true, failed: [] });
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

describe('the turn contract’s slots and loop-capabilities.yaml keys (#276 G6)', () => {
  const place = (position: string, key: string): string => `${position} ${key}`;

  it('marks exactly the places the oracle lists as rejecting a slot, and the slot each expanding place expands', () => {
    const marked = ENGINE_CAPABILITIES.positions.flatMap((p) => p.keys.flatMap((k) => (k.slots === undefined ? [] : [{ at: place(positionIdOf(p), k.key), slots: k.slots }])));
    expect({
      rejected: marked.filter((m) => m.slots.kind === 'rejected').map((m) => m.at).sort(),
      expanded: marked.flatMap((m) => (m.slots.kind === 'expanded' ? [`${m.at} ${m.slots.slot}`] : [])).sort(),
    }).toEqual({
      rejected: SLOT_REJECTING.map((r) => place(r.position, r.key)).sort(),
      expanded: SLOT_EXPANDING.map((e) => `${place(e.position, e.key)} ${e.slot}`).sort(),
    });
  });

  it('fails a definition with a slot at each slot-rejecting place, and loads it without the slot', () => {
    const problems = SLOT_REJECTING.flatMap(({ position, key }) => {
      const sample = samplesAt(position)[key];
      if (typeof sample !== 'string') return [`${place(position, key)}: the sample is not a string`];
      const load = (value: string) => loadAt(position, fieldsAt(position, positionKeys(position), { [key]: value })).ok;
      return [
        ...(load(withSlot(sample)) ? [`${place(position, key)}: loads with a slot`] : []),
        ...(load(sample) ? [] : [`${place(position, key)}: fails without a slot`]),
      ];
    });
    expect(problems).toEqual([]);
  });

  it('fails a loop-capabilities.yaml without each required key, and parses one without each optional key', () => {
    const samples: Readonly<Record<string, unknown>> = {
      test_globs: ['tests/**/*.test.ts'],
      test_command: 'pnpm test',
      build_command: 'pnpm run build',
      select_template: 'red-loop',
      red_check_command: 'node scripts/red-check.mjs',
    };
    const without = (key: string): boolean =>
      parseLoopCapabilities(
        Object.entries(samples)
          .filter(([k]) => k !== key)
          .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
          .join('\n'),
      ).ok;
    expect({
      unsampled: Object.keys(LOOP_CAPABILITIES_KEYS).filter((k) => !(k in samples)),
      parsesWhole: without(''),
      parsesWithout: Object.keys(LOOP_CAPABILITIES_KEYS).filter(without).sort(),
    }).toEqual({
      unsampled: [],
      parsesWhole: true,
      parsesWithout: Object.entries(LOOP_CAPABILITIES_KEYS)
        .filter(([, required]) => required === 'never')
        .map(([k]) => k)
        .sort(),
    });
  });
});
