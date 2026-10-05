import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveExampleLoopsV2Dir } from '../../src/main/exampleAssets';
import { resolveLoopDefV2 } from '../../src/main/loopDefV2';
import { EPIC_GRAMMAR, POLISH_REPORT_HEADING } from '../../src/shared/epicPlan';
import { SLICE_GRAMMAR } from '../../src/shared/slicePlan';

const SOURCE = resolveExampleLoopsV2Dir({ packaged: false, appPath: resolve(__dirname, '..', '..') });
const LOOP = 'plan-bundle-loop';
const POLISH_LOOP = 'plan-polish-loop';
const read = (rel: string): string => readFileSync(join(SOURCE, rel), 'utf8');
const charters = [LOOP, POLISH_LOOP].flatMap((loop) =>
  readdirSync(join(SOURCE, loop, 'charter')).map((f) => `${loop}/charter/${f}`),
);
const resolveDef = (name: string) =>
  resolveLoopDefV2(name, { tiers: { operator: null, appBundled: SOURCE, retired: null }, repoDir: resolve(__dirname, '..', '..') });

// Headings that appear only in the plan-polish method, so a recipe carrying all of them carries the method.
const POLISH_METHOD_MARKERS = [
  '# Plan Polish — harden an implementation plan against its ticket',
  '## The decision rule — DO vs RECOMMEND',
  '### 1. Proportion',
  '### 2. Overspecification',
  '### 3. Ticket↔plan tensions',
  '### 4. Ticket driftables',
  '### 5. Surface existing standards',
  '### 6. Create missing context',
  '## Invariants you must not break',
  '## Anti-patterns',
];

const MATERIALITY_MARKER = 'Raise a finding only where';
const SCOPE_MARKER = 'beyond what the ticket requires';
const ADVERSARY_MARKER = 'an attack outside that scope';
const ALTITUDE_MARKER = 'contracts and intent';

describe('planning-loop review discipline (plan-bundle + plan-polish)', () => {
  for (const f of charters) {
    it(`${f} carries the materiality floor`, () => expect(read(f)).toContain(MATERIALITY_MARKER));
    it(`${f} treats additions beyond the ticket as a finding`, () => expect(read(f)).toContain(SCOPE_MARKER));
  }

  it('the work recipe forbids adding scope beyond the ticket', () =>
    expect(read(`${LOOP}/prompts/work.md`)).toContain(SCOPE_MARKER));

  it('the security charter bounds the adversary and routes a new attack class to a human', () => {
    const security = read(`${POLISH_LOOP}/charter/security.md`);
    expect(security).toContain(ADVERSARY_MARKER);
    expect(security).toContain('needs a human');
  });

  it('the plan is written at contract altitude, and maintainability no longer demands code-level detail', () => {
    expect(read(`${LOOP}/prompts/work.md`)).toContain(ALTITUDE_MARKER);
    const maintainability = read(`${POLISH_LOOP}/charter/maintainability.md`);
    expect(maintainability).toContain(ALTITUDE_MARKER);
    expect(maintainability).not.toContain('Layer-3 detail');
  });

  it('plan-bundle defers polish and plan-polish fixes it', () => {
    const bundle = resolveDef(LOOP);
    const polish = resolveDef(POLISH_LOOP);
    expect(bundle.ok && polish.ok).toBe(true);
    if (bundle.ok) expect(bundle.def.report.polish).toBe('defer');
    if (polish.ok) expect(polish.def.report.polish).toBe('fix');
  });
});

describe('plan-polish work turn', () => {
  const recipe = (): string => {
    const r = resolveDef(POLISH_LOOP);
    if (!r.ok) throw new Error(r.reason);
    return readFileSync(r.def.work.recipe, 'utf8');
  };

  it('carries the full plan-polish method', () => {
    const body = recipe();
    for (const marker of POLISH_METHOD_MARKERS) expect(body, marker).toContain(marker);
  });

  it('forbids changing the ticket or anything outside the plan from inside the loop', () =>
    expect(recipe()).toContain('Do not edit the ticket'));

  it('reports decisions in the plan instead of asking mid-turn', () => expect(recipe()).toContain(POLISH_REPORT_HEADING));

  it('holds every machine-read plan token binding, so the gate still finds the slices and sub-tickets after polish', () => {
    const body = recipe();
    for (const token of [...Object.values(EPIC_GRAMMAR), ...Object.values(SLICE_GRAMMAR)]) expect(body, token).toContain(token);
  });

  it('reads the ticket and the plan, and writes the plan', () => {
    const r = resolveDef(POLISH_LOOP);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.def.inputs.map((i) => i.id).sort()).toEqual(['groomed-ticket', 'plan']);
    expect(r.def.outputs.map((o) => o.id)).toEqual(['plan']);
  });
});
