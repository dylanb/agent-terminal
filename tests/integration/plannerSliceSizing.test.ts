import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { bundledPath } from '../helpers/bundledLoops';

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

const PLANNERS = ['plan-loop', 'plan-bundle-loop', 'plan-goal-loop'];
const SLICING_REVIEWERS = ['plan-bundle-loop', 'plan-polish-loop', 'plan-goal-loop'].map((loop) => `${loop}/charter/tracer-slicer.md`);
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
    expect(read('plan-bundle-loop/charter/tracer-slicer.md')).toContain(NOT_A_FINDING_MARKER));
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
