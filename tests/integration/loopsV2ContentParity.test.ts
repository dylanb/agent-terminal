import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FEATURE_DEV_ID, resolveExampleLoopsV2Dir } from '../../src/main/exampleAssets';
import { resolveLoopDefV2 } from '../../src/main/loopDefV2';
import { EPIC_GRAMMAR, epicPlanWellFormed, exampleEpicPlan, isEpicPlan, parseEpicPlan } from '../../src/shared/epicPlan';
import { exampleSlicePlan, parseSlicePlan, slicePlanWellFormed, SLICE_GRAMMAR } from '../../src/shared/slicePlan';
import { LOOP_CAPABILITIES_FILENAME } from '../../src/main/loopCapabilities';
import { RED_COMPLETING_OUTCOME, GREEN_COMPLETING_OUTCOME, type PhaseOutcome } from '../../src/shared/phaseOutcome';
import { GREEN_COMPLETING_BUILD_OUTCOME } from '../../src/shared/buildOutcome';
import { composePhaseResultInstruction, readPhaseResult, PHASE_RESULT_FIELDS } from '../../src/shared/phaseResult';

// §28.6 (P6b/P6c) — content-parity pins for the five new charters + work recipes S6 authors under
// feature-dev-v3's folder of example/loops-v2/. Authored content only: S7 wires the loop defs that consume them, so this file never
// resolves a def (the §28.10 S6 / S7 boundary).

const BUNDLE_TREE = resolveExampleLoopsV2Dir({ packaged: false, appPath: resolve(__dirname, '..', '..') });
const SOURCE_TREE = join(BUNDLE_TREE, FEATURE_DEV_ID);

// A dead engine token is a copy-paste leak of engine plumbing into human-facing content: an unfilled `{{…}}`
// template placeholder from the loops-repo source, or a citation of the retired section. The needle is
// CONSTRUCTED from the glyph so this file is not a self-match for the retired-section citation grep.
const SECTION = String.fromCharCode(0xa7);
const DEAD_TOKENS = ['{{', `${SECTION}26`] as const;

// The four planning artifacts the plan-goal recipe produces as delimited sections (§28.8 P8.1: one loop,
// one work turn, all four files). One definition — authored as the recipe's headings and matched
// heading-anchored — so pin and recipe cannot drift.
const PLANNING_SECTIONS = ['test plan', 'technical plan', 'infrastructure plan', 'slice plan'] as const;

interface CharterRow {
  file: string;
  persona: string;
  marker: string;
}
type RecipeRow =
  | { kind: 'planning'; file: string; sections: readonly string[] }
  | { kind: 'phase'; file: string; completes: 'red' | 'green' }
  | { kind: 'plain'; file: string };

const NEW_CHARTERS: readonly CharterRow[] = [
  { file: 'plan-goal-loop/charter/test-architect.md', persona: 'review-plan-test-architect', marker: 'AC-to-test bijection' },
  { file: 'plan-goal-loop/charter/determinism.md', persona: 'review-plan-determinism', marker: 'Scriptable-per-turn' },
  { file: 'plan-goal-loop/charter/tracer-slicer.md', persona: 'review-plan-tracer-slicer', marker: 'Thin-but-complete' },
  { file: 'red-loop/charter/red-authenticity.md', persona: 'impl-review-red-authenticity', marker: 'Fails for the right reason' },
  { file: 'green-loop/charter/regression-guard.md', persona: 'impl-review-regression-guard', marker: 'No vacuous green' },
];

const isPlanningCharter = (c: CharterRow): boolean =>
  c.file.startsWith('plan-goal-loop/charter/');
const isPhaseCharter = (c: CharterRow): boolean => c.persona.startsWith('impl-review-');

const NEW_RECIPES: readonly RecipeRow[] = [
  { kind: 'planning', file: 'plan-goal-loop/prompts/work.md', sections: PLANNING_SECTIONS },
  { kind: 'plain', file: 'infra-loop/prompts/work.md' },
  { kind: 'phase', file: 'red-loop/prompts/work.md', completes: 'red' },
  { kind: 'phase', file: 'green-loop/prompts/work.md', completes: 'green' },
];

/** null rather than throwing, so a missing-content pin fails by assertion, never an uncaught ENOENT
 *  that would read as a collection error. */
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

  it('the two charter-contract classes cover every charter exactly once', () => {
    for (const c of NEW_CHARTERS) {
      expect(isPlanningCharter(c) !== isPhaseCharter(c), `${c.file}: not in exactly one contract class`).toBe(true);
    }
  });

  it('every recipe file is distinct and the planning sections are the shared constant', () => {
    const files = NEW_RECIPES.map((r) => r.file);
    expect(new Set(files).size).toBe(files.length);
    const planning = NEW_RECIPES.find((r) => r.kind === 'planning');
    expect(planning && planning.kind === 'planning' ? planning.sections : []).toEqual([...PLANNING_SECTIONS]);
  });

  it('the source-tree accessor resolves and read() works against the shipped tree', () => {
    expect(read('plan-goal-loop/plan-goal-loop.yaml')).not.toBeNull();
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
  for (const row of NEW_CHARTERS.filter(isPlanningCharter)) {
    describe(row.file, () => assertCharterContract(row));
  }
});

describe('loops-v2 content-parity — the 2 phase-discipline charters (§28.6 P6b)', () => {
  for (const row of NEW_CHARTERS.filter(isPhaseCharter)) {
    describe(row.file, () => assertCharterContract(row));
  }

  // §28.5.3
  it('regression-guard names the changed-test flag it reads', () => {
    expect(read('green-loop/charter/regression-guard.md') ?? '').toContain('changed-test flag');
  });
});

function completingOutcome(completes: 'red' | 'green'): PhaseOutcome {
  return completes === 'red' ? RED_COMPLETING_OUTCOME : GREEN_COMPLETING_OUTCOME;
}

/** §28.5.5 — the composer embeds exactly one fenced block. */
function embeddedExample(lines: string[]): string {
  const text = lines.join('\n');
  return text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
}

// §28.6 P6c. The work-turn composer owns the result-file embed (§28.5.5), so a phase recipe carries none.
describe('loops-v2 content-parity — the four work recipes (§28.6 P6c)', () => {
  for (const row of NEW_RECIPES) {
    describe(row.file, () => {
      it('exists and references the capabilities file', () => {
        const body = read(row.file);
        expect(body, `recipe absent: ${row.file}`).not.toBeNull();
        expect(body).toContain(LOOP_CAPABILITIES_FILENAME);
      });
      it('contains no dead engine token', () => {
        const body = read(row.file) ?? '';
        for (const token of DEAD_TOKENS) expect(body, `${row.file}: dead token ${token}`).not.toContain(token);
      });
      if (row.kind === 'planning') {
        it('has a heading for each planning section', () => {
          const body = read(row.file) ?? '';
          for (const section of row.sections) {
            const hasHeading = body.split('\n').some((l) => /^#+\s/.test(l) && l.toLowerCase().includes(section));
            expect(hasHeading, `${row.file}: no heading for '${section}'`).toBe(true);
          }
        });
      }
      if (row.kind === 'phase') {
        it('names its completing outcome in a delimited backticked context', () => {
          const body = read(row.file) ?? '';
          expect(body).toContain(`\`${completingOutcome(row.completes)}\``);
          if (row.completes === 'green') expect(body).toContain(`\`${GREEN_COMPLETING_BUILD_OUTCOME}\``);
        });
        it('embeds no result-file block', () => {
          expect(read(row.file) ?? '').not.toContain(`"${PHASE_RESULT_FIELDS.outcome}"`);
        });
      }
    });
  }

  for (const completes of ['red', 'green'] as const) {
    it(`the ${completes} completing outcome composes a well-formed example`, () => {
      const lines =
        completes === 'green'
          ? composePhaseResultInstruction({ resultRel: 'result.md', completingOutcome: GREEN_COMPLETING_OUTCOME, build: { completingBuildOutcome: GREEN_COMPLETING_BUILD_OUTCOME }, closing: [] })
          : composePhaseResultInstruction({ resultRel: 'result.md', completingOutcome: RED_COMPLETING_OUTCOME, closing: [] });
      expect(readPhaseResult(embeddedExample(lines)).ok).toBe(true);
    });
  }
});

// §28.10 (the S6/S7 boundary) — asserted iff-wired (not a fixed set) so it holds at every intermediate
// S7 slice.
describe('loops-v2 content-parity — S6 content stays present, a dir resolves once wired', () => {
  const newDirs = [...new Set([...NEW_CHARTERS, ...NEW_RECIPES].map((r) => r.file.split('/')[0]))];
  const repoDir = resolve(__dirname, '..', '..');

  const present = (sub: 'charter' | 'prompts'): Set<string> =>
    new Set(
      newDirs.flatMap((dir) => {
        const d = join(SOURCE_TREE, dir, sub);
        return existsSync(d) ? readdirSync(d).map((f) => `${dir}/${sub}/${f}`) : [];
      }),
    );

  it('keeps every S6-authored charter present under its new dir', () => {
    const files = present('charter');
    for (const c of NEW_CHARTERS) expect(files.has(c.file), c.file).toBe(true);
  });

  it('keeps every S6-authored recipe present under its new dir', () => {
    const files = present('prompts');
    for (const r of NEW_RECIPES) expect(files.has(r.file), r.file).toBe(true);
  });

  for (const dir of newDirs) {
    it(`${dir} resolves to a def iff its yaml exists`, () => {
      const wired = existsSync(join(SOURCE_TREE, dir, `${dir}.yaml`));
      const r = resolveLoopDefV2(dir, { tiers: { operator: null, appBundled: BUNDLE_TREE, retired: null }, repoDir, flow: FEATURE_DEV_ID });
      expect(r.ok).toBe(wired);
      if (!r.ok) expect(r.reason).toContain(`no ${SECTION}27 def named ${dir}`);
    });
  }
});

// §28.7 — the plan-goal recipe is the WRITER of the epic-plan grammar, and its approve gate declares the
// `promote` side-effect that fans an epic out. Both single-sourced from src/shared/epicPlan.ts (§28.5.5 /
// composed-prompt-is-a-writer): the recipe embeds a canonical example asserted well-formed against the predicate.
describe('plan-goal epic classification content (§28.7)', () => {
  const repoDir = resolve(__dirname, '..', '..');
  const tiers = { operator: null, appBundled: BUNDLE_TREE, retired: null };

  // The brief carries more than one fenced ```text example, so each test picks the fence for ITS grammar
  // (by a token only that grammar's block contains) rather than "the first fence".
  const fences = (recipe: string): string[] => [...recipe.matchAll(/```text\n([\s\S]*?)```/g)].map((m) => m[1]);

  it('the brief embeds a canonical epic example the predicate accepts (writer↔predicate parity)', () => {
    const recipe = read('plan-goal-loop/prompts/brief.md') ?? '';
    const example = fences(recipe).find((f) => f.includes(EPIC_GRAMMAR.subTicketsHeading));
    expect(example, 'the recipe must embed a fenced epic example').not.toBeUndefined();
    expect(isEpicPlan(example ?? '')).toBe(true);
    expect(epicPlanWellFormed(example ?? '')).toBe(true);
    expect(parseEpicPlan(example ?? '')?.subTickets).toHaveLength(2);
    // pin the embedded few-shot to the single source, so a well-formed reword cannot silently drift (§93)
    expect((example ?? '').trim()).toBe(exampleEpicPlan(2).trim());
  });

  it('§28.4.1 — the brief embeds a canonical impl-slices example the predicate accepts (writer↔predicate parity)', () => {
    const recipe = read('plan-goal-loop/prompts/brief.md') ?? '';
    const example = fences(recipe).find((f) => f.includes(SLICE_GRAMMAR.implSlicesHeading));
    expect(example, 'the recipe must embed a fenced impl-slices example').not.toBeUndefined();
    expect(slicePlanWellFormed(example ?? '')).toBe(true);
    expect(parseSlicePlan(example ?? '').implSlices).toHaveLength(2);
    // pin the embedded few-shot to the single source (§93)
    expect((example ?? '').trim()).toBe(exampleSlicePlan(2).trim());
  });

  // §28.4.1 — the tracer-slicer reviewer is the soft gate that the plan carries the machine-readable block the
  // impl-slice count is sourced from. Its charter must NAME that block from the one grammar token (writer↔reader,
  // §93 / composed-prompt-is-a-writer) so a token rename moves the charter with it, and must not demand it of an
  // epic plan, which carries §28.7's `## Sub-tickets` instead.
  it('§28.4.1 — the tracer-slicer charter requires the impl-slices block, named from the shared grammar', () => {
    const charter = read('plan-goal-loop/charter/tracer-slicer.md') ?? '';
    expect(charter, 'the tracer-slicer charter must exist').not.toBe('');
    expect(charter).toContain(SLICE_GRAMMAR.implSlicesHeading); // '## Impl-slices'
    expect(charter).toContain(SLICE_GRAMMAR.implSlice); // '### Impl-slice'
    expect(charter).toContain(EPIC_GRAMMAR.subTicketsHeading); // '## Sub-tickets' — the epic exception
  });

  it('the plan-approve gate declares the promote side-effect naming the plan artifact', () => {
    const r = resolveLoopDefV2('plan-approve-loop', { tiers, repoDir, flow: FEATURE_DEV_ID });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const approve = r.def.gate.find((g) => g.option === 'approve');
    const promote = approve?.sideEffects.find((se) => se.kind === 'promote');
    expect(promote?.args.artifact).toBe('plan');
  });
});

describe('planning and phase work recipes carry every reviewer standard they are graded against', () => {
  const repoDir = resolve(__dirname, '..', '..');
  const tiers = { operator: null, appBundled: BUNDLE_TREE, retired: null };
  const STANDARDS_LEAD = 'Standards to apply:';
  const flat = (s: string): string => s.replace(/\s+/g, ' ');
  const standardsOf = (charterBody: string): string | null => {
    const para = charterBody.split(/\n\s*\n/).find((p) => p.startsWith(STANDARDS_LEAD));
    return para === undefined ? null : flat(para.slice(STANDARDS_LEAD.length)).trim();
  };

  const loops = [
    ...['groom-goal-loop', 'plan-goal-loop', 'infra-loop', 'red-loop', 'green-loop', 'refactor-loop', 'integration-slice-loop'].map((loop) => ({ flow: FEATURE_DEV_ID, loop })),
    { flow: 'plan-only', loop: 'groom-loop' },
  ];
  for (const { flow, loop } of loops) {
    it(`${flow}/${loop}: the brief, which the work and review-and-fix turns both carry, restates each reviewer's standards once`, () => {
      const r = resolveLoopDefV2(loop, { tiers, repoDir, flow });
      if (!r.ok) throw new Error(r.reason);
      expect(r.def.brief, `${loop} declares no brief`).toBeDefined();
      const brief = flat(readFileSync(r.def.brief!, 'utf8'));
      const recipe = flat(readFileSync(r.def.work.recipe, 'utf8'));
      for (const reviewer of r.def.reviewers) {
        const standards = standardsOf(readFileSync(reviewer.charter, 'utf8'));
        expect(standards, `${reviewer.persona}: charter has no standards paragraph`).not.toBeNull();
        expect(brief, `${loop} brief omits ${reviewer.persona}'s standards`).toContain(standards);
        expect(recipe, `${loop} work recipe repeats ${reviewer.persona}'s standards`).not.toContain(standards);
      }
    });
  }
});

describe('the standing rules every fix must also meet live in the brief, not the work recipe (§27.3)', () => {
  const repoDir = resolve(__dirname, '..', '..');
  const tiers = { operator: null, appBundled: BUNDLE_TREE, retired: null };
  const AC_RULE = 'No acceptance criterion may be deferred';
  const TODO_RULE = 'Do not add a TODO or FIXME comment';
  const loops: { flow: string; loop: string; rules: string[] }[] = [
    { flow: FEATURE_DEV_ID, loop: 'plan-goal-loop', rules: [AC_RULE] },
    { flow: FEATURE_DEV_ID, loop: 'infra-loop', rules: [AC_RULE, TODO_RULE] },
    { flow: FEATURE_DEV_ID, loop: 'red-loop', rules: [AC_RULE, TODO_RULE] },
    { flow: FEATURE_DEV_ID, loop: 'green-loop', rules: [AC_RULE, TODO_RULE] },
    { flow: FEATURE_DEV_ID, loop: 'refactor-loop', rules: [AC_RULE, TODO_RULE] },
    { flow: FEATURE_DEV_ID, loop: 'integration-slice-loop', rules: [AC_RULE, TODO_RULE] },
    { flow: 'plan-only', loop: 'plan-loop', rules: [AC_RULE] },
  ];
  for (const { flow, loop, rules } of loops) {
    it(`${flow}/${loop}: the brief carries ${rules.length === 1 ? 'the AC rule' : 'the AC and TODO rules'}`, () => {
      const r = resolveLoopDefV2(loop, { tiers, repoDir, flow });
      if (!r.ok) throw new Error(r.reason);
      expect(r.def.brief, `${loop} declares no brief`).toBeDefined();
      const brief = readFileSync(r.def.brief!, 'utf8');
      const recipe = readFileSync(r.def.work.recipe, 'utf8');
      for (const rule of rules) {
        expect(brief, rule).toContain(rule);
        expect(recipe, rule).not.toContain(rule);
      }
    });
  }
});
