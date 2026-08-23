import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveExampleLoopsV2Dir } from '../../src/main/exampleAssets';

// §28.6 (P6b/P6c) — content-parity pins for the five new charters + work recipes S6 authors under
// example/loops-v2/. Authored content only: S7 wires the loop defs that consume them, so this file never
// resolves a def (the §28.10 S6 / S7 boundary).

const SOURCE_TREE = resolveExampleLoopsV2Dir({ packaged: false, appPath: resolve(__dirname, '..', '..') });

// A dead engine token is a copy-paste leak of engine plumbing into human-facing content: an unfilled `{{…}}`
// template placeholder from the loops-repo source, or a citation of the retired section. The needle is
// CONSTRUCTED from the glyph so this file is not a self-match for the retired-section citation grep.
const SECTION = String.fromCharCode(0xa7);
const DEAD_TOKENS = ['{{', `${SECTION}26`] as const;

// The four planning artifacts the plan-bundle recipe produces as delimited sections (§28.8 P8.1: one loop,
// one work turn, all four files). One definition — authored as the recipe's headings and matched
// heading-anchored — so pin and recipe cannot drift.
const PLANNING_SECTIONS = ['test plan', 'technical plan', 'infrastructure plan', 'slice plan'] as const;

interface CharterRow {
  file: string;
  persona: string;
  marker: string;
}
type RecipeRow =
  | { kind: 'plan-bundle'; file: string; sections: readonly string[] }
  | { kind: 'phase'; file: string; completes: 'red' | 'green' }
  | { kind: 'plain'; file: string };

const NEW_CHARTERS: readonly CharterRow[] = [
  { file: 'plan-bundle-loop/charter/test-architect.md', persona: 'review-plan-test-architect', marker: 'AC-to-test bijection' },
  { file: 'plan-bundle-loop/charter/determinism.md', persona: 'review-plan-determinism', marker: 'Scriptable-per-turn' },
  { file: 'plan-bundle-loop/charter/tracer-slicer.md', persona: 'review-plan-tracer-slicer', marker: 'Thin-but-complete' },
  { file: 'red-loop/charter/red-authenticity.md', persona: 'impl-review-red-authenticity', marker: 'Fails for the right reason' },
  { file: 'green-loop/charter/regression-guard.md', persona: 'impl-review-regression-guard', marker: 'No vacuous green' },
];

const NEW_RECIPES: readonly RecipeRow[] = [
  { kind: 'plan-bundle', file: 'plan-bundle-loop/prompts/work.md', sections: PLANNING_SECTIONS },
  { kind: 'plain', file: 'infra-loop/prompts/work.md' },
  { kind: 'phase', file: 'red-loop/prompts/work.md', completes: 'red' },
  { kind: 'phase', file: 'green-loop/prompts/work.md', completes: 'green' },
];

/** The file's content, or null when absent/unreadable — so a content pin fails by assertion on missing
 *  content, never an uncaught ENOENT that would read as a collection error. */
function read(rel: string): string | null {
  try {
    return readFileSync(join(SOURCE_TREE, rel), 'utf8');
  } catch {
    return null;
  }
}

describe('loops-v2 content-parity — manifest is internally consistent', () => {
  it('every charter file, persona, and marker is distinct and well-shaped', () => {
    const files = NEW_CHARTERS.map((c) => c.file);
    const markers = NEW_CHARTERS.map((c) => c.marker);
    const personas = NEW_CHARTERS.map((c) => c.persona);
    expect(new Set(files).size).toBe(files.length);
    expect(new Set(markers).size).toBe(markers.length);
    expect(new Set(personas).size).toBe(personas.length);
    for (const c of NEW_CHARTERS) {
      expect(c.marker.trim().length).toBeGreaterThan(0);
      expect(c.persona).toMatch(/^(review-plan|impl-review)-[a-z-]+$/);
    }
  });

  it('every recipe file is distinct and the plan-bundle sections are the shared constant', () => {
    const files = NEW_RECIPES.map((r) => r.file);
    expect(new Set(files).size).toBe(files.length);
    const planBundle = NEW_RECIPES.find((r) => r.kind === 'plan-bundle');
    expect(planBundle && planBundle.kind === 'plan-bundle' ? planBundle.sections : []).toEqual([...PLANNING_SECTIONS]);
  });

  it('the source-tree accessor resolves and read() works against the shipped tree', () => {
    expect(read('impl-loop/impl-loop.yaml')).not.toBeNull();
    expect(read('does-not-exist/nope.md')).toBeNull();
  });
});

// §28.6 P6b
function assertCharterContract(row: CharterRow): void {
  it('exists and carries its distinctive marker', () => {
    const body = read(row.file);
    expect(body, `charter absent: ${row.file}`).not.toBeNull();
    expect(body).toContain(row.marker);
  });
  it('composes the ported charter structure', () => {
    const body = read(row.file) ?? '';
    const firstNonEmpty = body.split('\n').find((l) => l.trim().length > 0) ?? '';
    expect(firstNonEmpty).toMatch(/^# Reviewer charter — /);
    expect(body).toContain(`Derived from persona: ${row.persona}.`);
    const afterPersona = body.split(`Derived from persona: ${row.persona}.`)[1] ?? '';
    expect(afterPersona.trim().length, `${row.file}: empty lane body`).toBeGreaterThan(0);
  });
  it('contains no dead engine token', () => {
    const body = read(row.file) ?? '';
    for (const token of DEAD_TOKENS) expect(body, `${row.file}: dead token ${token}`).not.toContain(token);
  });
}

describe('loops-v2 content-parity — the 3 planning-discipline charters (§28.6 P6b)', () => {
  for (const row of NEW_CHARTERS.filter((c) => c.file.startsWith('plan-bundle-loop/charter/'))) {
    describe(row.file, () => assertCharterContract(row));
  }
});

describe('loops-v2 content-parity — the 2 phase-discipline charters (§28.6 P6b)', () => {
  for (const row of NEW_CHARTERS.filter((c) => c.persona.startsWith('impl-review-'))) {
    describe(row.file, () => assertCharterContract(row));
  }

  // §28.5.3 — regression-guard is the persona that reads the machine's changed-test flag and advises the
  // human; the charter must name that flag so S7 wires the right reviewer to it.
  it('regression-guard names the changed-test flag it reads', () => {
    expect(read('green-loop/charter/regression-guard.md') ?? '').toContain('changed-test flag');
  });
});
