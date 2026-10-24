import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { BUNDLED_LOOPS_ROOT, bundledPath } from '../helpers/bundledLoops';
import { MAX_SLICES } from '../../src/main/flow';
import { PHASE_RESULT_FIELDS } from '../../src/shared/phaseResult';

// Slice sizing is planning-agent-only guidance: the planner's briefs carry it, no reviewer charter grades it,
// and the slicing reviewer is told it is not a finding — so a plan that merges small slices is not re-litigated.
const read = (rel: string): string => readFileSync(bundledPath(rel), 'utf8');

const SIZING_MARKERS = ['no more than 5 impl-slices', 'one eighth', '200 lines'];
const NOT_A_FINDING_MARKER = 'slice count and size are the planner’s call';
const SPLIT_RULE_MARKER = 'Never plan RED/GREEN increments inside one impl-slice';
const SPLIT_OVERRIDES_SIZING_MARKER = 'This split overrides every sizing rule';
const SPLIT_FINDING_MARKER = 'two increments planned as one';
const TARGET_MARKER = 'no more than 5 impl-slices';
const DEPENDENCY_LIMIT_MARKER = 'more than 10 dependency-ordered slices';
const DEPENDENCY_LIMIT_OF_5 = /more than 5 dependency-ordered/;
const ONLY_SPLIT_EXCEEDS_TARGET = /only the dependency split[^.]*past 5[^.]*10/;

const PLANNERS = ['plan-loop', 'plan-goal-loop'];
const inEveryFlow = (rel: string): string[] =>
  readdirSync(BUNDLED_LOOPS_ROOT)
    .map((flow) => join(BUNDLED_LOOPS_ROOT, flow, 'red-loop', rel))
    .filter((f) => existsSync(f));
const RED_BRIEFS = inEveryFlow('prompts/brief.md');
const RED_AUTHENTICITY_CHARTERS = inEveryFlow('charter/red-authenticity.md');
const SLICING_REVIEWERS = ['plan-goal-loop'].map((loop) => `${loop}/charter/tracer-slicer.md`);
const charters = (loop: string): string[] =>
  readdirSync(bundledPath(`${loop}/charter`)).map((f) => `${loop}/charter/${f}`);

describe('planner slice sizing (planning-agent-only guidance)', () => {
  for (const loop of PLANNERS) {
    for (const marker of SIZING_MARKERS) {
      it(`${loop}/prompts/brief.md carries the sizing rule "${marker}"`, () =>
        expect(read(`${loop}/prompts/brief.md`)).toContain(marker));
    }

    for (const f of charters(loop)) {
      it(`${f} does not grade slice sizing`, () => {
        for (const marker of SIZING_MARKERS) expect(read(f)).not.toContain(marker);
      });
    }
  }

  it('the tracer-slicer reviewer is told slice count and size are not a finding', () =>
    expect(read('plan-goal-loop/charter/tracer-slicer.md')).toContain(NOT_A_FINDING_MARKER));
});

// A RED step must see every test in its slice fail at its own check before any of the slice's production code
// exists, so an increment whose checks are reachable only after another increment's GREEN is a slice of its own.
describe('planner splits impl-slices at every RED/GREEN dependency', () => {
  for (const loop of PLANNERS) {
    it(`${loop}/prompts/brief.md makes every dependent increment its own impl-slice`, () =>
      expect(read(`${loop}/prompts/brief.md`)).toContain(SPLIT_RULE_MARKER));

    it(`${loop}/prompts/brief.md puts the dependency split above the sizing rules`, () =>
      expect(read(`${loop}/prompts/brief.md`)).toContain(SPLIT_OVERRIDES_SIZING_MARKER));

    it(`${loop}/prompts/brief.md targets 5 impl-slices and lets only the dependency split reach 10`, () => {
      const brief = read(`${loop}/prompts/brief.md`).replace(/\s+/g, ' ').replace(/\*\*/g, '');
      expect(brief).toContain(TARGET_MARKER);
      expect(brief).toMatch(ONLY_SPLIT_EXCEEDS_TARGET);
      expect(brief).toContain(DEPENDENCY_LIMIT_MARKER);
      expect(brief).not.toMatch(DEPENDENCY_LIMIT_OF_5);
    });
  }

  for (const f of SLICING_REVIEWERS) {
    it(`${f} grades a slice that hides a dependent increment as a finding`, () =>
      expect(read(f)).toContain(SPLIT_FINDING_MARKER));
  }
});

// A plan approved with a dependent increment still inside one impl-slice is caught by the RED step that cannot
// reach a check: it splits that slice in the plan itself rather than stopping, and the RED gate re-sources the
// count (§28.4.1), so the extra slice runs.
describe('the RED step splits its own slice at a dependency the plan missed', () => {
  const SPLIT_IN_RED_MARKER = 'split this slice in the plan';
  const EARLIER_SLICES_UNTOUCHED_MARKER = 'Never renumber or edit an impl-slice before this one';
  const NO_AC_LOST_MARKER = 'every acceptance criterion of the slice lands in exactly one of the new entries';
  const LATER_TESTS_OUT_MARKER = 'tests that belong to a later entry leave this change';

  it('covers every bundled red-loop brief', () => expect(RED_BRIEFS.length).toBeGreaterThanOrEqual(1));

  for (const f of RED_BRIEFS) {
    const rel = f.slice(BUNDLED_LOOPS_ROOT.length + 1);
    it(`${rel} tells the RED worker to split the slice instead of stopping`, () => {
      const brief = readFileSync(f, 'utf8').replace(/\s+/g, ' ');
      expect(brief).toContain(SPLIT_IN_RED_MARKER);
      expect(brief).toContain(EARLIER_SLICES_UNTOUCHED_MARKER);
      expect(brief).toContain(NO_AC_LOST_MARKER);
      expect(brief).toContain(LATER_TESTS_OUT_MARKER);
    });
  }
});

// The 10-slice limit bounds the initial plan only: a RED that finds a further dependency splits again without
// asking, and stops for the operator only where the flow would no longer run every slice (MAX_SLICES).
describe('a RED split is limited by what the flow runs, not by the initial plan\'s limit', () => {
  for (const f of RED_BRIEFS) {
    const rel = f.slice(BUNDLED_LOOPS_ROOT.length + 1);
    const brief = (): string => readFileSync(f, 'utf8').replace(/\s+/g, ' ').replace(/\*\*/g, '');

    it(`${rel} does not stop a split at 10 impl-slices`, () => {
      expect(brief()).not.toMatch(/10 impl-slices or fewer|past 10/);
      expect(brief()).toContain('The limit of 10 impl-slices applies to the initial plan');
    });

    it(`${rel} stops for the operator only past the ${MAX_SLICES} impl-slices the flow runs`, () =>
      expect(brief()).toContain(`past ${MAX_SLICES} impl-slices`));
  }
});

// A slice whose behavior an earlier slice already built has no check left to see fail: RED records its new tests
// as a verification of that behavior and continues, after showing each check can fail.
describe('a RED whose slice is already built verifies it instead of stopping', () => {
  for (const f of RED_BRIEFS) {
    const rel = f.slice(BUNDLED_LOOPS_ROOT.length + 1);
    it(`${rel} tells the RED worker to write a verification-only result, with evidence each check can fail`, () => {
      const brief = readFileSync(f, 'utf8').replace(/\s+/g, ' ');
      expect(brief).toContain(`"${PHASE_RESULT_FIELDS.verificationOnly}": true`);
      expect(brief).toContain('scratch copy');
      expect(brief).toContain('do not stop for the operator');
    });
  }

  it('covers every bundled red-authenticity charter', () => expect(RED_AUTHENTICITY_CHARTERS.length).toBeGreaterThanOrEqual(1));

  for (const f of RED_AUTHENTICITY_CHARTERS) {
    const rel = f.slice(BUNDLED_LOOPS_ROOT.length + 1);
    it(`${rel} grades a verification-only RED`, () => {
      const charter = readFileSync(f, 'utf8').replace(/\s+/g, ' ');
      expect(charter).toContain('verification-only');
      expect(charter).toContain('scratch copy');
    });
  }
});
