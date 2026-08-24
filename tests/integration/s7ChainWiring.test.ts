import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveExampleLoopsV2Dir } from '../../src/main/exampleAssets';

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
  output: { id: string; path: string } | null;
  personas: PersonaRow[];
}

const IMPL_LANES = ['principal', 'tests', 'security', 'taint', 'reliability', 'architecture', 'contracts', 'intent', 'maintainability', 'conventions', 'accessibility', 'diagrams'] as const;
const PLAN_LANES = ['principal', 'security', 'architecture', 'intent', 'maintainability', 'contracts'] as const;

const plan = (lane: string): PersonaRow => ({ persona: `review-plan-${lane}`, charter: `charter/${lane}.md`, source: { loop: 'plan-loop', charter: `plan-loop/charter/${lane}.md` } });
const impl = (lane: string): PersonaRow => ({ persona: `impl-review-${lane}`, charter: `charter/${lane}.md`, source: { loop: 'impl-loop', charter: `impl-loop/charter/${lane}.md` } });
const fromPlanBundle = (persona: string, lane: string): PersonaRow => ({ persona, charter: `charter/${lane}.md`, source: { loop: 'plan-bundle-loop', charter: `plan-bundle-loop/charter/${lane}.md` } });
const authored = (persona: string, lane: string): PersonaRow => ({ persona, charter: `charter/${lane}.md` });

export const CHAIN: readonly LoopRow[] = [
  {
    name: 'plan-bundle-loop', kind: 'plan', completion: null, gate: ['gh'], pickup: true,
    consolidateSource: 'plan-loop', output: null,
    personas: [
      ...PLAN_LANES.map(plan),
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
    personas: [...IMPL_LANES.map(impl), authored('impl-review-regression-guard', 'regression-guard')],
  },
  {
    name: 'refactor-loop', kind: 'phase', completion: 'refactor', gate: ['commit'], pickup: false,
    consolidateSource: 'impl-loop', output: null,
    personas: [...IMPL_LANES.map(impl)],
  },
  {
    name: 'integration-slice-loop', kind: 'impl', completion: null, gate: ['commit', 'gh'], pickup: false,
    consolidateSource: 'impl-loop', output: null,
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

  it('gives exactly one loop the pickup that creates the shared branch', () => {
    expect(CHAIN.filter((l) => l.pickup).length).toBe(1);
  });
});
