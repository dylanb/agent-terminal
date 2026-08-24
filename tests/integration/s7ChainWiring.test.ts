import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveExampleLoopsV2Dir } from '../../src/main/exampleAssets';
import { resolveLoopDefV2, type LoopDefV2 } from '../../src/main/loopDefV2';
import { catalogPersonas } from '../../src/main/reviewTurn';
import { createRealAppGateCommit } from '../../src/main/appGateCommit';
import { LOOP_CAPABILITIES_FILENAME } from '../../src/main/loopCapabilities';
import { PHASE_RESULT_GRAMMAR } from '../../src/shared/phaseResult';
import { createGitRepoFixture } from '../helpers/gitRepo';

// §28.10 S7 (§28.2)

const SOURCE_TREE = resolveExampleLoopsV2Dir({ packaged: false, appPath: resolve(__dirname, '..', '..') });

type Completion = 'red' | 'green' | 'refactor';

interface PersonaRow {
  persona: string;
  charter: string;
  // `source` present ⇒ the charter is a byte-copy of another loop's charter, pinned against drift by
  // C8/C4b; absent ⇒ authored in this loop's own dir (S6).
  source?: { loop: string; charter: string };
}

interface LoopRow {
  name: string;
  kind: 'plan' | 'impl' | 'phase';
  completion: Completion | null;
  gate: ('commit' | 'gh')[];
  pickup: boolean;
  consolidateSource: string;
  input: { id: string; path: string };
  output: { id: string; path: string } | null;
  personas: PersonaRow[];
}

const PLAN_INPUT = { id: 'plan', path: 'plan.md' } as const;

const IMPL_LANES = ['principal', 'tests', 'security', 'taint', 'reliability', 'architecture', 'contracts', 'intent', 'maintainability', 'conventions', 'accessibility', 'diagrams'] as const;
const PLAN_LANES = ['principal', 'security', 'architecture', 'intent', 'maintainability', 'contracts'] as const;

const plan = (lane: string): PersonaRow => ({ persona: `review-plan-${lane}`, charter: `charter/${lane}.md`, source: { loop: 'plan-loop', charter: `plan-loop/charter/${lane}.md` } });
const impl = (lane: string): PersonaRow => ({ persona: `impl-review-${lane}`, charter: `charter/${lane}.md`, source: { loop: 'impl-loop', charter: `impl-loop/charter/${lane}.md` } });
const fromPlanBundle = (persona: string, lane: string): PersonaRow => ({ persona, charter: `charter/${lane}.md`, source: { loop: 'plan-bundle-loop', charter: `plan-bundle-loop/charter/${lane}.md` } });
const authored = (persona: string, lane: string): PersonaRow => ({ persona, charter: `charter/${lane}.md` });

export const CHAIN: readonly LoopRow[] = [
  {
    name: 'plan-bundle-loop', kind: 'plan', completion: null, gate: ['gh'], pickup: true,
    consolidateSource: 'plan-loop', input: { id: 'groomed-ticket', path: 'groomed-ticket.md' }, output: null,
    personas: [
      ...PLAN_LANES.map(plan),
      authored('review-plan-test-architect', 'test-architect'),
      authored('review-plan-determinism', 'determinism'),
      authored('review-plan-tracer-slicer', 'tracer-slicer'),
    ],
  },
  {
    name: 'infra-loop', kind: 'impl', completion: null, gate: ['commit'], pickup: false,
    consolidateSource: 'impl-loop', input: PLAN_INPUT, output: null,
    personas: [
      ...['tests', 'security', 'taint', 'reliability', 'maintainability', 'conventions', 'architecture'].map(impl),
      fromPlanBundle('review-plan-determinism', 'determinism'),
    ],
  },
  {
    name: 'red-loop', kind: 'phase', completion: 'red', gate: ['commit'], pickup: false,
    consolidateSource: 'impl-loop', input: PLAN_INPUT, output: { id: 'red-result', path: 'red-result.md' },
    personas: [...['tests', 'intent'].map(impl), authored('impl-review-red-authenticity', 'red-authenticity')],
  },
  {
    name: 'green-loop', kind: 'phase', completion: 'green', gate: ['commit'], pickup: false,
    consolidateSource: 'impl-loop', input: PLAN_INPUT, output: { id: 'green-result', path: 'green-result.md' },
    personas: [...IMPL_LANES.map(impl), authored('impl-review-regression-guard', 'regression-guard')],
  },
  {
    name: 'refactor-loop', kind: 'phase', completion: 'refactor', gate: ['commit'], pickup: false,
    consolidateSource: 'impl-loop', input: PLAN_INPUT, output: null,
    personas: [...IMPL_LANES.map(impl)],
  },
  {
    name: 'integration-slice-loop', kind: 'impl', completion: null, gate: ['commit', 'gh'], pickup: false,
    consolidateSource: 'impl-loop', input: PLAN_INPUT, output: null,
    personas: [...IMPL_LANES.map(impl), fromPlanBundle('review-plan-tracer-slicer', 'tracer-slicer')],
  },
];

function charterExists(rel: string): boolean {
  return existsSync(join(SOURCE_TREE, rel));
}

describe('s7 chain manifest — internally consistent (§28.10 S7)', () => {
  it('describes exactly the six new loops with distinct names', () => {
    expect(CHAIN.length).toBe(6);
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
      if (wantsBinding) expect(loop.output).toEqual({ id: `${loop.completion}-result`, path: `${loop.completion}-result.md` });
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

const WIRED = ['plan-bundle-loop', 'infra-loop', 'red-loop', 'green-loop', 'refactor-loop'];

const REPO_DIR = resolve(__dirname, '..', '..');
const resolveDef = (name: string) => resolveLoopDefV2(name, { tiers: { operator: null, appBundled: SOURCE_TREE, retired: null }, repoDir: REPO_DIR });

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

  it('declares the manifest chained input', () => {
    expect(mustResolve(name).inputs.some((i) => i.id === row.input.id), `${name} input ${row.input.id}`).toBe(true);
  });

  it('binds the result output the manifest declares', () => {
    const out = row.output;
    if (!out) return;
    expect(mustResolve(name).outputs.some((o) => o.id === out.id), `${name} output ${out.id}`).toBe(true);
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
      const result = await createRealAppGateCommit(repo)({ label: label as string });
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
    const rel = 'refactor-loop/prompts/work.md';
    expect(existsSync(join(SOURCE_TREE, rel)), rel).toBe(true);
    const body = readFileSync(join(SOURCE_TREE, rel), 'utf8');
    expect(body).toContain(LOOP_CAPABILITIES_FILENAME);
    expect(body).not.toContain(PHASE_RESULT_GRAMMAR.capturedOutputHeading);
  });
});
