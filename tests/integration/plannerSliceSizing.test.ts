import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { bundledPath } from '../helpers/bundledLoops';

// Slice sizing is planning-agent-only guidance: the planner's briefs carry it, no reviewer charter grades it,
// and the slicing reviewer is told it is not a finding — so a plan that merges small slices is not re-litigated.
const read = (rel: string): string => readFileSync(bundledPath(rel), 'utf8');

const SIZING_MARKERS = ['no more than 5 impl-slices', 'one eighth', '200 lines'];
const NOT_A_FINDING_MARKER = 'slice count and size are the planner’s call';

const PLANNERS = ['plan-loop', 'plan-bundle-loop'];
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
