import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveExampleLoopsV2Dir } from '../../src/main/exampleAssets';

// The v2 engine hands a reviewer only its charter PATH; the reviewer opens and reads the whole file
// (reviewTurn.ts). So a charter is the reviewer's entire briefing, and "v1 persona parity" (the intent
// bundledLoopsV2.test.ts states but only checks by membership) means each charter must carry the SAME
// review depth the v1 skill did — not a thin summary. This pins that content parity: every ported charter
// carries the shared v1 charter fragments, its own persona's domain body, and none of the retired Go
// engine's I/O scaffolding (the {{token}} substitutions, the JSON review envelope's validator, the
// per-cycle severity floor, the legal-verdict-strings block). Markers are lifted from the v1 sources so the
// test stays self-contained once example/loops/ is deleted.

const SOURCE = resolveExampleLoopsV2Dir({ packaged: false, appPath: resolve(__dirname, '..', '..') });
const charter = (loop: string, persona: string): string =>
  readFileSync(join(SOURCE, loop, 'charter', `${persona}.md`), 'utf8');

// Shared charter fragments composed into EVERY ported persona charter (v1 charter/00-preamble, 01a, 07).
const SHARED_MARKERS = [
  'You are a picky senior specialist in your lane', // 00-preamble
  "Translate your standards into this repository's stack", // 01a-stack-translation
  '### Depth probes', // 07-depth-probes
];

// Each persona's v1 SKILL H1 (identity) + a phrase unique to that skill's domain body (right-skill guard).
const PERSONAS: Array<{ loop: string; persona: string; h1: string; marker: string }> = [
  { loop: 'impl-loop', persona: 'principal', h1: '# Review: principal (cross-cutting)', marker: 'trajectory' },
  { loop: 'impl-loop', persona: 'tests', h1: '# Review: tests', marker: 'hermeticity' },
  { loop: 'impl-loop', persona: 'security', h1: '# Review: security', marker: 'Aperture' },
  { loop: 'impl-loop', persona: 'taint', h1: '# Review: taint', marker: 'suspicion-by-default' },
  { loop: 'impl-loop', persona: 'reliability', h1: '# Review: reliability', marker: 'calls that can fail' },
  { loop: 'impl-loop', persona: 'architecture', h1: '# Review: architecture', marker: 'Reversibility heuristic' },
  { loop: 'impl-loop', persona: 'contracts', h1: '# Review: contracts', marker: 'literal-value parity' },
  { loop: 'impl-loop', persona: 'intent', h1: '# Review: intent', marker: 'AC contract' },
  { loop: 'impl-loop', persona: 'maintainability', h1: '# Review: maintainability', marker: 'AI Navigability' },
  { loop: 'impl-loop', persona: 'conventions', h1: '# Review: conventions', marker: 'editorconfig' },
  { loop: 'impl-loop', persona: 'accessibility', h1: '# Review: accessibility', marker: 'screen-reader user' },
  { loop: 'impl-loop', persona: 'diagrams', h1: '# Review: diagrams (system impact)', marker: 'Mermaid' },
  { loop: 'plan-loop', persona: 'architecture', h1: '# Review: architecture (plan-only)', marker: 'Seams reused vs. invented' },
  { loop: 'plan-loop', persona: 'contracts', h1: '# Review: contracts (plan-only)', marker: 'Wire-format choice' },
  { loop: 'plan-loop', persona: 'intent', h1: '# Review: intent (plan-only)', marker: 'Per-sub-ticket AC partition' },
  { loop: 'plan-loop', persona: 'maintainability', h1: '# Review: maintainability (plan-only)', marker: 'Dev-loop impact' },
  { loop: 'plan-loop', persona: 'principal', h1: '# Review: principal (cross-cutting plan judgment)', marker: 'Elevation authority' },
  { loop: 'plan-loop', persona: 'security', h1: '# Review: security (plan-only)', marker: 'Reach into existing sinks' },
];

// Retired Go-engine I/O scaffolding that MUST NOT survive the port (omitted fragments 03/08 + the
// {{REVIEW-INSTRUCTIONS}} block's validator + any unresolved template token).
const DEAD_MARKERS = [
  '{{', // no unresolved template token survives
  'agent-loop validate review', // charter/09-review-instructions — the JSON-envelope validator CLI
  'Severity floor for THIS iteration', // charter/03-severity-floor — no v2 per-cycle floor
  '### Legal verdict strings', // charter/08-legal-verdict-strings — deferred to the verdicts PR
];

describe('loops-v2 charters carry full v1 fidelity (content parity)', () => {
  for (const { loop, persona, h1, marker } of PERSONAS) {
    describe(`${loop}/${persona}`, () => {
      it('carries the persona identity + a domain-unique marker', () => {
        const c = charter(loop, persona);
        expect(c, `${loop}/${persona}: missing H1 "${h1}"`).toContain(h1);
        expect(c, `${loop}/${persona}: missing domain marker "${marker}"`).toContain(marker);
      });

      it('inlines the shared charter fragments', () => {
        const c = charter(loop, persona);
        for (const m of SHARED_MARKERS) {
          expect(c, `${loop}/${persona}: missing shared fragment "${m}"`).toContain(m);
        }
      });

      it('is full-fidelity length, not the thin summary', () => {
        expect(
          charter(loop, persona).length,
          `${loop}/${persona}: charter too short to be full fidelity`,
        ).toBeGreaterThan(2000);
      });

      it('carries no retired-engine scaffolding', () => {
        const c = charter(loop, persona);
        for (const d of DEAD_MARKERS) {
          expect(c, `${loop}/${persona}: retired-engine text present "${d}"`).not.toContain(d);
        }
      });
    });
  }
});

// The work/consolidate recipes are injected verbatim into the work-agent / consolidator prompts
// (appWorkTurn / consolidateTurn), so their enrichment is behavior-bearing. Pin the ported v1 discipline
// AND that the v2 verdict mechanics survived, and that no retired-engine terminal-line / token leaked in.
const prompt = (loop: string, name: string): string =>
  readFileSync(join(SOURCE, loop, 'prompts', `${name}.md`), 'utf8');

// runtime tokens + retired terminal-line protocols that must not survive into a v2 recipe.
const PROMPT_DEAD = ['{{', 'epic-promote', 'SELF-REVIEW COMPLETE', 'PLAN-SELF-REVIEW COMPLETE'];

const PROMPT_PARITY: Array<{ loop: string; name: string; markers: string[] }> = [
  { loop: 'impl-loop', name: 'work', markers: ['principal engineer', 'Lean MVP', 'red → green → refactor', 'Pre-push self-review'] },
  { loop: 'plan-loop', name: 'work', markers: ['Sizing comes from you', 'Banned details', 'Pre-review plan self-check'] },
  { loop: 'impl-loop', name: 'consolidate', markers: ['product owner', 'three buckets', 'another round', 'stop for a human'] },
  { loop: 'plan-loop', name: 'consolidate', markers: ['product owner', 'three buckets', 'another round'] },
];

describe('loops-v2 recipes enriched with v1 discipline (content parity)', () => {
  for (const { loop, name, markers } of PROMPT_PARITY) {
    describe(`${loop}/${name}`, () => {
      it('carries the ported v1 discipline markers', () => {
        const p = prompt(loop, name);
        for (const m of markers) expect(p, `${loop}/${name}: missing "${m}"`).toContain(m);
      });
      it('carries no retired-engine terminal-line or token', () => {
        const p = prompt(loop, name);
        for (const d of PROMPT_DEAD) expect(p, `${loop}/${name}: retired-engine text "${d}"`).not.toContain(d);
      });
    });
  }
});
