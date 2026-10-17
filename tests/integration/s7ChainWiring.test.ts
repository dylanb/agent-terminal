import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { load } from 'js-yaml';
import { FEATURE_DEV_ID, resolveExampleLoopsV2Dir, resolveFeatureDevFlowDir } from '../../src/main/exampleAssets';
import { resolveLoopDefV2, type LoopDefV2 } from '../../src/main/loopDefV2';
import { catalogPersonas } from '../../src/main/reviewTurn';
import { createRealAppGateCommit } from '../../src/main/appGateCommit';
import { LOOP_CAPABILITIES_FILENAME } from '../../src/main/loopCapabilities';
import { PHASE_RESULT_FIELDS } from '../../src/shared/phaseResult';
import { createGitRepoFixture } from '../helpers/gitRepo';

// §28.10 S7 (§28.2)

const BUNDLE_TREE = resolveExampleLoopsV2Dir({ packaged: false, appPath: resolve(__dirname, '..', '..') });
const SOURCE_TREE = join(BUNDLE_TREE, FEATURE_DEV_ID);

type Completion = 'red' | 'green' | 'refactor';

interface PersonaRow {
  persona: string;
  charter: string;
  // `source` present ⇒ the charter is a byte-copy of another feature-dev-v2 loop's charter, pinned against
  // drift by C8/C4b; absent ⇒ authored in this loop's own dir. Sources never cross into another flow's folder
  // (§27.8: each flow's loops change independently).
  source?: { loop: string; charter: string };
}

interface LoopRow {
  name: string;
  kind: 'plan' | 'impl' | 'phase';
  completion: Completion | null;
  gate: ('commit' | 'gh' | 'promote')[];
  pickup: boolean;
  consolidateSource: string;
  input: { id: string; path: string };
  output: { id: string; path: string } | null;
  // §27.4
  records?: { id: string; path: string }[];
  personas: PersonaRow[];
  polish: 'fix' | 'defer';
}

const PLAN_INPUT = { id: 'plan', path: 'plan.md' } as const;

const IMPL_LANES = ['principal', 'tests', 'security', 'taint', 'reliability', 'architecture', 'contracts', 'intent', 'maintainability', 'conventions', 'accessibility', 'diagrams'] as const;
// Per-slice catalogs are narrower than the integration-slice sweep, which re-runs every IMPL_LANES lens once
// over the whole ticket diff (§27.8 `polish: defer`).
const GREEN_LANES = ['principal', 'tests', 'security', 'taint', 'reliability', 'architecture', 'contracts', 'intent', 'accessibility'] as const;
const REFACTOR_LANES = ['principal', 'tests', 'reliability', 'architecture'] as const;
const PLAN_LANES = ['principal', 'security', 'architecture', 'intent', 'maintainability', 'contracts'] as const;

const impl = (lane: string): PersonaRow => ({ persona: `impl-review-${lane}`, charter: `charter/${lane}.md`, source: { loop: 'integration-slice-loop', charter: `integration-slice-loop/charter/${lane}.md` } });
const fromPlanPolish = (persona: string, lane: string): PersonaRow => ({ persona, charter: `charter/${lane}.md`, source: { loop: 'plan-polish-loop', charter: `plan-polish-loop/charter/${lane}.md` } });
const authored = (persona: string, lane: string): PersonaRow => ({ persona, charter: `charter/${lane}.md` });
const authoredPlan = (lane: string): PersonaRow => authored(`review-plan-${lane}`, lane);
const authoredImpl = (lane: string): PersonaRow => authored(`impl-review-${lane}`, lane);

export const CHAIN: readonly LoopRow[] = [
  {
    name: 'plan-bundle-loop', kind: 'plan', completion: null, gate: [], pickup: true,
    consolidateSource: 'plan-bundle-loop', input: { id: 'groomed-ticket', path: 'groomed-ticket.md' }, output: null,
    polish: 'defer',
    // Authored here, not copied: §28.8.1's bundle review leaves mechanism to the implementation's tests,
    // which plan-polish's and integration-slice's charters do not.
    personas: [authoredPlan('principal'), authoredPlan('intent'), authored('review-plan-tracer-slicer', 'tracer-slicer')],
  },
  {
    name: 'plan-polish-loop', kind: 'plan', completion: null, gate: ['gh', 'promote'], pickup: false,
    consolidateSource: 'plan-polish-loop', input: PLAN_INPUT, output: null,
    polish: 'fix',
    personas: [
      ...PLAN_LANES.map(authoredPlan),
      authored('review-plan-test-architect', 'test-architect'),
      authored('review-plan-determinism', 'determinism'),
      authored('review-plan-tracer-slicer', 'tracer-slicer'),
    ],
  },
  {
    name: 'infra-loop', kind: 'impl', completion: null, gate: ['commit'], pickup: false,
    consolidateSource: 'infra-loop', input: PLAN_INPUT, output: null,
    records: [{ id: 'infra-capabilities', path: 'infra-capabilities.md' }],
    polish: 'defer',
    personas: [
      ...['principal', 'tests', 'security', 'taint', 'reliability', 'maintainability', 'conventions', 'architecture'].map(authoredImpl),
      authored('review-plan-determinism', 'determinism'),
    ],
  },
  {
    name: 'red-loop', kind: 'phase', completion: 'red', gate: ['commit'], pickup: false,
    consolidateSource: 'integration-slice-loop', input: PLAN_INPUT, output: { id: 'red-result', path: 'red-result.json' },
    polish: 'defer',
    personas: [...['tests', 'intent'].map(impl), authored('impl-review-red-authenticity', 'red-authenticity')],
  },
  {
    name: 'green-loop', kind: 'phase', completion: 'green', gate: ['commit'], pickup: false,
    consolidateSource: 'integration-slice-loop', input: PLAN_INPUT, output: { id: 'green-result', path: 'green-result.json' },
    polish: 'defer',
    personas: [...GREEN_LANES.map(impl), authored('impl-review-regression-guard', 'regression-guard')],
  },
  {
    name: 'refactor-loop', kind: 'phase', completion: 'refactor', gate: ['commit'], pickup: false,
    consolidateSource: 'integration-slice-loop', input: PLAN_INPUT, output: null,
    polish: 'defer',
    personas: [...REFACTOR_LANES.map(impl)],
  },
  {
    name: 'integration-slice-loop', kind: 'impl', completion: null, gate: ['commit', 'gh'], pickup: false,
    consolidateSource: 'integration-slice-loop', input: PLAN_INPUT, output: null,
    polish: 'fix',
    personas: [...IMPL_LANES.map(authoredImpl), fromPlanPolish('review-plan-tracer-slicer', 'tracer-slicer')],
  },
];

function charterExists(rel: string): boolean {
  return existsSync(join(SOURCE_TREE, rel));
}

describe('s7 chain manifest — internally consistent (§28.10 S7)', () => {
  it('describes exactly the seven new loops with distinct names', () => {
    expect(CHAIN.length).toBe(7);
    const names = CHAIN.map((l) => l.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('gives every loop a non-empty catalog of distinct personas', () => {
    for (const loop of CHAIN) {
      const personas = loop.personas.map((p) => p.persona);
      expect(personas.length, `${loop.name}: empty catalog`).toBeGreaterThan(0);
      expect(new Set(personas).size, `${loop.name}: duplicate persona`).toBe(personas.length);
    }
  });

  it('points every reused charter at a source file that exists on disk', () => {
    for (const loop of CHAIN) {
      for (const p of loop.personas) {
        if (!p.source) continue;
        expect(charterExists(p.source.charter), `${loop.name}/${p.persona}: missing source ${p.source.charter}`).toBe(true);
      }
    }
  });

  it('finds every authored (non-copied) charter already in its loop dir', () => {
    for (const loop of CHAIN) {
      for (const p of loop.personas) {
        if (p.source) continue;
        expect(charterExists(`${loop.name}/${p.charter}`), `${loop.name}/${p.persona}: missing ${p.charter}`).toBe(true);
      }
    }
  });

  it('names a consolidate-recipe source that exists for every loop', () => {
    for (const loop of CHAIN) {
      expect(charterExists(`${loop.consolidateSource}/prompts/consolidate.md`), `${loop.name}: consolidate source`).toBe(true);
    }
  });

  it('carries a completion mode iff the loop is a phase, and a mode-matched result binding iff red/green', () => {
    for (const loop of CHAIN) {
      expect(loop.completion !== null, `${loop.name}: phase⇔completion`).toBe(loop.kind === 'phase');
      const wantsBinding = loop.completion === 'red' || loop.completion === 'green';
      expect(loop.output !== null, `${loop.name}: red/green⇔output binding`).toBe(wantsBinding);
      if (wantsBinding) expect(loop.output).toEqual({ id: `${loop.completion}-result`, path: `${loop.completion}-result.json` });
    }
  });

  it('names a chained input for every loop', () => {
    for (const loop of CHAIN) {
      expect(loop.input.id.length, `${loop.name}: input id`).toBeGreaterThan(0);
      expect(loop.input.path.length, `${loop.name}: input path`).toBeGreaterThan(0);
    }
  });

  it('gives exactly one loop the pickup that creates the shared branch', () => {
    expect(CHAIN.filter((l) => l.pickup).length).toBe(1);
  });
});

const WIRED = ['plan-bundle-loop', 'plan-polish-loop', 'infra-loop', 'red-loop', 'green-loop', 'refactor-loop', 'integration-slice-loop'];

const REPO_DIR = resolve(__dirname, '..', '..');
const resolveDef = (name: string) =>
  resolveLoopDefV2(name, { tiers: { operator: null, appBundled: BUNDLE_TREE, retired: null }, repoDir: REPO_DIR, flow: FEATURE_DEV_ID });

function mustResolve(name: string): LoopDefV2 {
  const r = resolveDef(name);
  expect(r.ok, `${name} did not resolve`).toBe(true);
  return (r as Extract<typeof r, { ok: true }>).def;
}

const rowFor = (name: string): LoopRow => {
  const row = CHAIN.find((l) => l.name === name);
  if (!row) throw new Error(`no manifest row: ${name}`);
  return row;
};

const bytesUnder = (rel: string): string => readFileSync(join(SOURCE_TREE, rel), 'utf8');

describe.each(WIRED)('s7 wiring — %s matches its manifest row', (name) => {
  const row = rowFor(name);

  it('resolves to a def whose catalog is the manifest personas', () => {
    expect(catalogPersonas(mustResolve(name)).slice().sort()).toEqual(row.personas.map((p) => p.persona).sort());
  });

  it('declares the manifest polish policy (a deferring loop is re-reviewed by a later polish-fixing loop)', () => {
    expect(mustResolve(name).report.polish).toBe(row.polish);
  });

  it('resolves every reviewer charter on disk', () => {
    for (const rev of mustResolve(name).reviewers) {
      expect(existsSync(rev.charter), `${name}/${rev.persona}: ${rev.charter}`).toBe(true);
    }
  });

  it('declares the manifest pickup, completion, and approve-gate side-effect kinds', () => {
    const def = mustResolve(name);
    expect(def.pickup !== null, `${name} pickup`).toBe(row.pickup);
    expect(def.work.completion ?? null).toBe(row.completion);
    const approve = def.gate.find((g) => g.option === 'approve');
    expect(approve?.sideEffects.map((se) => se.kind).slice().sort()).toEqual([...row.gate].sort());
  });

  it('declares the manifest chained input (id + path)', () => {
    const binding = mustResolve(name).inputs.find((i) => i.id === row.input.id);
    expect(binding, `${name} input ${row.input.id}`).toBeDefined();
    expect(binding?.rel.split('/').pop()).toBe(row.input.path);
  });

  it('binds the result output the manifest declares (id + path)', () => {
    const out = row.output;
    if (!out) return;
    const binding = mustResolve(name).outputs.find((o) => o.id === out.id);
    expect(binding, `${name} output ${out.id}`).toBeDefined();
    expect(binding?.rel.split('/').pop()).toBe(out.path);
  });

  it('binds every record output the manifest declares (id + path)', () => {
    const outputs = mustResolve(name).outputs;
    for (const rec of row.records ?? []) {
      const binding = outputs.find((o) => o.id === rec.id);
      expect(binding, `${name} record ${rec.id}`).toBeDefined();
      expect(binding?.rel.split('/').pop()).toBe(rec.path);
    }
  });

  // §28.5.5 / CLAUDE.md shared-semantics — a reused charter/consolidate recipe is a byte-copy of its
  // canonical source; no type catches the drift.
  it('byte-copies every reused charter + the consolidate recipe from source', () => {
    for (const p of row.personas) {
      if (!p.source) continue;
      const copy = `${name}/${p.charter}`;
      expect(existsSync(join(SOURCE_TREE, copy)), copy).toBe(true);
      expect(bytesUnder(copy), copy).toBe(bytesUnder(p.source.charter));
    }
    const cons = `${name}/prompts/consolidate.md`;
    expect(existsSync(join(SOURCE_TREE, cons)), cons).toBe(true);
    expect(bytesUnder(cons)).toBe(bytesUnder(`${row.consolidateSource}/prompts/consolidate.md`));
  });

  it('gives every reused reviewer the tools of its source def', () => {
    const def = mustResolve(name);
    for (const p of row.personas) {
      if (!p.source) continue;
      const want = mustResolve(p.source.loop).reviewers.find((rv) => rv.persona === p.persona)?.tools;
      const got = def.reviewers.find((rv) => rv.persona === p.persona)?.tools;
      expect(got, `${name}/${p.persona} tools`).toEqual(want);
    }
  });
});

describe.each(WIRED.filter((n) => rowFor(n).gate.includes('commit')))('s7 commit-lands — %s', (name) => {
  it('lands its approve commit label as a real commit', async () => {
    const approve = mustResolve(name).gate.find((g) => g.option === 'approve');
    const label = approve?.sideEffects.find((se) => se.kind === 'commit')?.args.label;
    expect(typeof label, `${name} commit label`).toBe('string');
    const fx = createGitRepoFixture();
    try {
      const repo = fx.makeGitRepo('s7commit');
      fx.writeRepoFile(repo, '.gitignore', '.agent-terminal/\n');
      fx.writeRepoFile(repo, 'seed.txt', 'seed\n');
      fx.commitAll(repo, 'baseline');
      fx.writeRepoFile(repo, 'src/new.ts', 'export const x = 1;\n');
      const before = Number(fx.git(repo, ['rev-list', '--count', 'HEAD']));
      const result = await createRealAppGateCommit(repo)({ label: label as string, dirtyAtPhaseStart: [] });
      expect(result.outcome).toBe('committed');
      expect(Number(fx.git(repo, ['rev-list', '--count', 'HEAD']))).toBe(before + 1);
      expect(fx.git(repo, ['log', '-1', '--format=%s'])).toBe(label);
    } finally {
      fx.cleanup();
    }
  });
});

describe('s7 wiring — closure', () => {
  it('registers every wired loop (its yaml exists) in WIRED', () => {
    for (const loop of CHAIN) {
      if (!existsSync(join(SOURCE_TREE, loop.name, `${loop.name}.yaml`))) continue;
      expect(WIRED, `${loop.name} yaml exists but is not in WIRED`).toContain(loop.name);
    }
  });
});

describe('s7 refactor recipe (§28.6 P6c)', () => {
  it('references the capabilities file and embeds no result-file block', () => {
    const body = readFileSync(mustResolve('refactor-loop').work.recipe, 'utf8');
    expect(body).toContain(LOOP_CAPABILITIES_FILENAME);
    expect(body).not.toContain(`"${PHASE_RESULT_FIELDS.outcome}"`);
  });
});

const EXPECTED_FLOW: Array<[string, string, string | null]> = [
  ['preparation', 'manual', null],
  ['groom', 'loop', 'groom-loop'],
  ['plan-bundle', 'loop', 'plan-bundle-loop'],
  ['plan-polish', 'loop', 'plan-polish-loop'],
  ['infra', 'loop', 'infra-loop'],
  ['red', 'loop', 'red-loop'],
  ['green', 'loop', 'green-loop'],
  ['refactor', 'loop', 'refactor-loop'],
  ['integration-slice', 'loop', 'integration-slice-loop'],
  ['finalize', 'manual', null],
];

interface ShippedFlow {
  name: string;
  steps: Array<{ id: string; kind: string; loop?: string }>;
}

describe('s7 shipped flow — the full-TDD chain (§28.2, C1)', () => {
  const flowDir = resolveFeatureDevFlowDir({ packaged: false, appPath: resolve(__dirname, '..', '..') });
  const flow = load(readFileSync(join(flowDir, 'flow.yaml'), 'utf8')) as ShippedFlow;

  it('keeps the name feature-dev-v2', () => {
    expect(flow.name).toBe('feature-dev-v2');
  });

  it('chains groom → plan-bundle → plan-polish → infra → red → green → refactor → integration-slice in order', () => {
    expect(flow.steps.map((s) => [s.id, s.kind, s.loop ?? null])).toEqual(EXPECTED_FLOW);
  });

  it('resolves every loop step to a parseable def', () => {
    for (const s of flow.steps) {
      if (s.kind !== 'loop' || !s.loop) continue;
      expect(resolveDef(s.loop).ok, s.loop).toBe(true);
    }
  });

  // §28.8.1 (C-AC2)
  it('plans in two loops between groom and infra, the plan-polish gate alone publishing and promoting the plan', () => {
    const ids = flow.steps.map((s) => s.id);
    const between = flow.steps.slice(ids.indexOf('groom') + 1, ids.indexOf('infra'));
    expect(between.filter((s) => s.kind === 'loop').map((s) => s.loop)).toEqual(['plan-bundle-loop', 'plan-polish-loop']);
    const approveKinds = (loop: string) =>
      mustResolve(loop).gate.filter((g) => g.option === 'approve').flatMap((g) => g.sideEffects.map((se) => se.kind));
    expect(approveKinds('plan-bundle-loop')).toEqual([]);
    expect(approveKinds('plan-polish-loop').slice().sort()).toEqual(['gh', 'promote']);
  });
});

describe('s7 integration-slice-loop (§28.2)', () => {
  it('references the capabilities file in its recipe', () => {
    expect(readFileSync(mustResolve('integration-slice-loop').work.recipe, 'utf8')).toContain(LOOP_CAPABILITIES_FILENAME);
  });

  it('publishes the PR body at its approve gate (C6b)', () => {
    const approve = mustResolve('integration-slice-loop').gate.find((g) => g.option === 'approve');
    const gh = approve?.sideEffects.find((se) => se.kind === 'gh');
    expect(gh?.args.action).toBe('publish-pr-body');
    expect(gh?.args.artifact).toBe('plan');
  });
});
