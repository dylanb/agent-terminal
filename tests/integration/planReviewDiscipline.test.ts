import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { bundledPath, resolveBundledLoop } from '../helpers/bundledLoops';
import { EPIC_GRAMMAR, POLISH_REPORT_HEADING } from '../../src/shared/epicPlan';
import { SLICE_GRAMMAR } from '../../src/shared/slicePlan';

const LOOP = 'plan-bundle-loop';
const POLISH_LOOP = 'plan-polish-loop';
const read = (rel: string): string => readFileSync(bundledPath(rel), 'utf8');
const charters = [LOOP, POLISH_LOOP].flatMap((loop) =>
  readdirSync(bundledPath(`${loop}/charter`)).map((f) => `${loop}/charter/${f}`),
);
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
const BUNDLE_ALTITUDE_MARKER = "this plan's own tests would catch";
const OVERREACH_MARKER = 'no acceptance criterion names';
const UNTESTABLE_MARKER = 'no test environment in the repository exercises';
const SAME_GUARD_MARKER = 'another hole in the same';

describe('planning-loop review discipline (plan-bundle + plan-polish)', () => {
  for (const f of charters) {
    it(`${f} carries the materiality floor`, () => expect(read(f)).toContain(MATERIALITY_MARKER));
    it(`${f} treats additions beyond the ticket as a finding`, () => expect(read(f)).toContain(SCOPE_MARKER));
  }

  // §28.8.1 — the bundle review checks the draft is complete and well-sliced; a mechanism bug the plan's own
  // tests would catch, or an addition no acceptance criterion names, is not work for that review to grow.
  for (const f of charters.filter((c) => c.startsWith(`${LOOP}/`))) {
    it(`${f} leaves mechanism defects to the implementation's tests`, () => expect(read(f)).toContain(BUNDLE_ALTITUDE_MARKER));
    it(`${f} routes an addition no acceptance criterion names to a human`, () => {
      expect(read(f)).toContain(OVERREACH_MARKER);
      expect(read(f)).toContain('needs a human decision');
    });
  }

  // #180 rounds 16–20: macOS-only and real-agent behaviour no repo test can reach kept review spinning, and each
  // fix patched one more hole in the same PATH-shim guard without anyone questioning the guard.
  for (const f of charters.filter((c) => c.startsWith(`${LOOP}/`))) {
    it(`${f} routes behaviour no test environment can reach to the plan's assumptions, not to elaboration`, () => {
      expect(read(f)).toContain(UNTESTABLE_MARKER);
      expect(read(f)).toContain('Assumptions');
    });
    it(`${f} treats another hole in the same guard as a sign the mechanism is wrong`, () => expect(read(f)).toContain(SAME_GUARD_MARKER));
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
    const security = read(`${POLISH_LOOP}/charter/security.md`);
    expect(security).toContain(ADVERSARY_MARKER);
    expect(security).toContain('needs a human');
  });

  it('the intent reviewer counts only what the ticket or a standard makes essential, not a general principle', () => {
    for (const loop of ['plan-loop', LOOP, POLISH_LOOP]) {
      const intent = read(`${loop}/charter/intent.md`);
      expect(intent, loop).toContain(ESSENTIAL_MARKER);
      expect(intent, loop).toContain('a likely future need');
    }
  });

  it('the plan is written at contract altitude, and maintainability no longer demands code-level detail', () => {
    expect(read(`${LOOP}/prompts/brief.md`)).toContain(ALTITUDE_MARKER);
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

  it('reads the ticket and the plan, and writes the plan', () => {
    const r = resolveDef(POLISH_LOOP);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.def.inputs.map((i) => i.id).sort()).toEqual(['groomed-ticket', 'plan']);
    expect(r.def.outputs.map((o) => o.id)).toEqual(['plan']);
  });
});

describe('plan-polish consolidator', () => {
  const consolidator = (): string => {
    const r = resolveDef(POLISH_LOOP);
    if (!r.ok) throw new Error(r.reason);
    if (r.def.rounds.kind !== 'engine') throw new Error('plan-polish-loop runs no review rounds');
    return readFileSync(r.def.rounds.consolidator, 'utf8');
  };

  it('reads the polish report, not only the round reports', () => expect(consolidator()).toContain(POLISH_REPORT_HEADING));

  it('stops for a human on an overbuilt verdict or an undecided scope escalation or call, ahead of every other verdict', () => {
    const body = consolidator();
    for (const marker of ['Proportion: overbuilt', 'Scope escalations', 'Needs your call', OPERATOR_DECISION, 'takes precedence over `clean` and `another round`']) {
      expect(body, marker).toContain(marker);
    }
  });
});
