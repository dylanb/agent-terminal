import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveExampleLoopsV2Dir } from '../../src/main/exampleAssets';

// §28.10 S7 — the single source describing the per-ticket loop chain S7 wires (§28.2). Every S7 wiring pin
// derives from this manifest so the loop→persona→charter data lives in one place (bundledLoopsV2.test.ts is
// left covering groom/plan/impl only). Authored complete here; later slices add the consuming pins that
// resolve the defs and assert against these rows.

const SOURCE_TREE = resolveExampleLoopsV2Dir({ packaged: false, appPath: resolve(__dirname, '..', '..') });

type Completion = 'red' | 'green' | 'refactor';

/** One reviewer in a loop's catalog. `source` present ⇒ the charter is a byte-copy of another loop's
 *  charter (pinned against drift by C8/C4b); absent ⇒ the charter is authored in this loop's own dir (S6). */
interface PersonaRow {
  persona: string;
  charter: string;
  source?: { loop: string; charter: string };
}

/** One loop in the chain. `pickup` is true only for the loop that creates the branch+PR; the rest run on
 *  it (the shared-branch hand-off, §28.4). `output` is the result-file binding a red/green completion
 *  requires (§28.5); null otherwise. */
interface LoopRow {
  name: string;
  kind: 'plan' | 'impl' | 'phase';
  completion: Completion | null;
  gate: ('commit' | 'gh')[];
  pickup: boolean;
  consolidateSource: string;
  output: { id: string; path: string } | null;
  personas: PersonaRow[];
}

const IMPL_12 = ['principal', 'tests', 'security', 'taint', 'reliability', 'architecture', 'contracts', 'intent', 'maintainability', 'conventions', 'accessibility', 'diagrams'] as const;
const PLAN_6 = ['principal', 'security', 'architecture', 'intent', 'maintainability', 'contracts'] as const;

const plan = (lane: string): PersonaRow => ({ persona: `review-plan-${lane}`, charter: `charter/${lane}.md`, source: { loop: 'plan-loop', charter: `plan-loop/charter/${lane}.md` } });
const impl = (lane: string): PersonaRow => ({ persona: `impl-review-${lane}`, charter: `charter/${lane}.md`, source: { loop: 'impl-loop', charter: `impl-loop/charter/${lane}.md` } });
/** A charter S6 authored in plan-bundle-loop's dir, copied into a later loop's dir (its canonical home). */
const fromPlanBundle = (persona: string, lane: string): PersonaRow => ({ persona, charter: `charter/${lane}.md`, source: { loop: 'plan-bundle-loop', charter: `plan-bundle-loop/charter/${lane}.md` } });
/** A charter S6 authored in this loop's own dir — no copy, no drift source. */
const authored = (persona: string, lane: string): PersonaRow => ({ persona, charter: `charter/${lane}.md` });

export const CHAIN: readonly LoopRow[] = [
  {
    name: 'plan-bundle-loop', kind: 'plan', completion: null, gate: ['gh'], pickup: true,
    consolidateSource: 'plan-loop', output: null,
    personas: [
      ...PLAN_6.map(plan),
      authored('review-plan-test-architect', 'test-architect'),
      authored('review-plan-determinism', 'determinism'),
      authored('review-plan-tracer-slicer', 'tracer-slicer'),
    ],
  },
  {
    name: 'infra-loop', kind: 'impl', completion: null, gate: ['commit'], pickup: false,
    consolidateSource: 'impl-loop', output: null,
    personas: [
      ...['tests', 'security', 'taint', 'reliability', 'maintainability', 'conventions', 'architecture'].map(impl),
      fromPlanBundle('review-plan-determinism', 'determinism'),
    ],
  },
  {
    name: 'red-loop', kind: 'phase', completion: 'red', gate: ['commit'], pickup: false,
    consolidateSource: 'impl-loop', output: { id: 'red-result', path: 'red-result.md' },
    personas: [...['tests', 'intent'].map(impl), authored('impl-review-red-authenticity', 'red-authenticity')],
  },
  {
    name: 'green-loop', kind: 'phase', completion: 'green', gate: ['commit'], pickup: false,
    consolidateSource: 'impl-loop', output: { id: 'green-result', path: 'green-result.md' },
    personas: [...IMPL_12.map(impl), authored('impl-review-regression-guard', 'regression-guard')],
  },
  {
    name: 'refactor-loop', kind: 'phase', completion: 'refactor', gate: ['commit'], pickup: false,
    consolidateSource: 'impl-loop', output: null,
    personas: [...IMPL_12.map(impl)],
  },
  {
    name: 'integration-slice-loop', kind: 'impl', completion: null, gate: ['commit', 'gh'], pickup: false,
    consolidateSource: 'impl-loop', output: null,
    personas: [...IMPL_12.map(impl), fromPlanBundle('review-plan-tracer-slicer', 'tracer-slicer')],
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

  it('names a consolidate-recipe source that exists for every loop', () => {
    for (const loop of CHAIN) {
      expect(charterExists(`${loop.consolidateSource}/prompts/consolidate.md`), `${loop.name}: consolidate source`).toBe(true);
    }
  });

  it('carries a completion mode iff the loop is a phase, and a result binding iff red/green', () => {
    for (const loop of CHAIN) {
      expect(loop.completion !== null, `${loop.name}: phase⇔completion`).toBe(loop.kind === 'phase');
      const wantsBinding = loop.completion === 'red' || loop.completion === 'green';
      expect(loop.output !== null, `${loop.name}: red/green⇔output binding`).toBe(wantsBinding);
    }
  });

  it('gives exactly one loop the pickup that creates the shared branch', () => {
    expect(CHAIN.filter((l) => l.pickup).length).toBe(1);
  });
});
