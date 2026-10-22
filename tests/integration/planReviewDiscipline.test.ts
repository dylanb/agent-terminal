import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { bundledPath, resolveBundledLoop } from '../helpers/bundledLoops';
import { EPIC_GRAMMAR, POLISH_REPORT_HEADING } from '../../src/shared/epicPlan';
import { SLICE_GRAMMAR } from '../../src/shared/slicePlan';

const LOOP = 'plan-goal-loop';
const read = (rel: string): string => readFileSync(bundledPath(rel), 'utf8');
const charters = readdirSync(bundledPath(`${LOOP}/charter`)).map((f) => `${LOOP}/charter/${f}`);
const resolveDef = resolveBundledLoop;

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
const ESSENTIAL_MARKER = "the repo's standards make essential to this change";
const OPERATOR_DECISION = 'Operator decision (';
const UNTESTABLE_MARKER = 'no test environment in the repository exercises';

describe('planning-loop review discipline (plan-goal)', () => {
  for (const f of charters) {
    it(`${f} carries the materiality floor`, () => expect(read(f)).toContain(MATERIALITY_MARKER));
    it(`${f} treats additions beyond the ticket as a finding`, () => expect(read(f)).toContain(SCOPE_MARKER));
  }

  it('the work recipe asks for an Assumptions list of behaviour no test environment exercises, each with its real-run check', () => {
    const recipe = read(`${LOOP}/prompts/work.md`);
    expect(recipe).toContain('Assumptions');
    expect(recipe).toContain(UNTESTABLE_MARKER);
    expect(recipe).toContain('real-run check');
  });

  it('the brief forbids adding scope beyond the ticket', () =>
    expect(read(`${LOOP}/prompts/brief.md`)).toContain(SCOPE_MARKER));

  it('the security charter bounds the adversary and routes a new attack class to a human', () => {
    const security = read(`${LOOP}/charter/security.md`);
    expect(security).toContain(ADVERSARY_MARKER);
    expect(security).toContain('needs a human');
  });

  it('the intent reviewer counts only what the ticket or a standard makes essential, not a general principle', () => {
    for (const loop of ['plan-loop', LOOP]) {
      const intent = read(`${loop}/charter/intent.md`);
      expect(intent, loop).toContain(ESSENTIAL_MARKER);
      expect(intent, loop).toContain('a likely future need');
    }
  });

  it('the plan is written at contract altitude, and maintainability no longer demands code-level detail', () => {
    expect(read(`${LOOP}/prompts/brief.md`)).toContain(ALTITUDE_MARKER);
    const maintainability = read(`${LOOP}/charter/maintainability.md`);
    expect(maintainability).toContain(ALTITUDE_MARKER);
    expect(maintainability).not.toContain('Layer-3 detail');
  });
});

describe('plan-goal work turn carries the plan-polish method', () => {
  const recipe = (): string => {
    const r = resolveDef(LOOP);
    if (!r.ok) throw new Error(r.reason);
    return `${readFileSync(r.def.brief!, 'utf8')}\n${readFileSync(r.def.work.recipe, 'utf8')}`;
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

  it('audits everything built beyond the acceptance criteria, not only defences, and routes the unsourced to the operator', () => {
    const body = recipe();
    for (const marker of [
      'Source every addition',
      'Prefer the simpler shape',
      'Name the adversary',
      'Review history is evidence, not authority',
      'a likely future need',
    ]) {
      expect(body, marker).toContain(marker);
    }
  });

  it('opens its report with a proportion verdict and lists scope escalations', () => {
    const body = recipe();
    for (const marker of ['Proportion: proportionate', 'Proportion: heavy', 'Proportion: overbuilt', '**Scope escalations**']) {
      expect(body, marker).toContain(marker);
    }
  });

  it('treats an item the plan records as an operator decision as settled', () => expect(recipe()).toContain(OPERATOR_DECISION));

  it('reads the ticket and its intent, and writes the plan and its report', () => {
    const r = resolveDef(LOOP);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.def.inputs.map((i) => i.id).sort()).toEqual(['groom-intent', 'groomed-ticket']);
    expect(r.def.outputs.map((o) => o.id)).toEqual(['plan', 'plan-report']);
  });
});
