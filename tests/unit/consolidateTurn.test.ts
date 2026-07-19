import { describe, expect, it } from 'vitest';
import { composeConsolidatePrompt, lastTwoReportRounds, preConsolidateBoundaryCommand } from '../../src/main/consolidateTurn';
import { CONSOLIDATOR_VERDICTS, consolidatorOutputWellFormed } from '../../src/shared/consolidatorOutput';
import type { LoopDefV2 } from '../../src/main/loopDefV2';

// §27.6/§27.7 — the pure, data-driven pieces of the §27 consolidator turn: the pre-consolidate boundary
// (data from the def, defaulting to clear which §27.7 prefers), the last-two-report window (a fixed window
// off the versioned report series, never growing with round depth), and the consolidator prompt — composed
// from the SHARED verdict vocabulary so the shape the actor is told to write and the shape the completion
// predicate accepts derive from one source (§93).

function def(over: Partial<LoopDefV2> = {}): LoopDefV2 {
  return {
    version: 'v2',
    name: 'plan-loop',
    origin: 'app-bundled',
    work: { recipe: '/tiers/plan-loop/prompts/work.md', artifact: 'plan' },
    reviewers: [
      { persona: 'review-plan-principal', charter: '/tiers/plan-loop/charter/principal.md', tools: ['Read'] },
      { persona: 'review-plan-security', charter: '/tiers/plan-loop/charter/security.md', tools: ['Read', 'Bash'] },
    ],
    consolidator: '/tiers/plan-loop/prompts/consolidate.md',
    boundaries: [
      { boundary: 'pre-work', mode: 'clear' },
      { boundary: 'pre-review', mode: 'compact', message: 'Keep the plan and the ticket.' },
      { boundary: 'pre-consolidate', mode: 'compact', message: 'Keep the two round reports.' },
    ],
    report: { sections: ['summary', 'findings', 'disposition'] },
    gate: [],
    pickup: { initialStatus: 'planning', branchTemplate: 'plan-loop/issue-{issue}' },
    inputs: [],
    outputs: [],
    exec: null,
    ...over,
  };
}

describe('preConsolidateBoundaryCommand — data-driven from the def (§27.7)', () => {
  it('issues the def-declared pre-consolidate boundary (a compact carrying its message)', () => {
    expect(preConsolidateBoundaryCommand(def())).toBe('/compact Keep the two round reports.');
  });

  it('defaults to /clear when the def declares no pre-consolidate boundary (§27.7 prefers clear)', () => {
    expect(preConsolidateBoundaryCommand(def({ boundaries: [{ boundary: 'pre-work', mode: 'clear' }] }))).toBe('/clear');
  });
});

describe('lastTwoReportRounds — a fixed window that does not grow with depth (AC2)', () => {
  it('is only this round on the first round (there is no previous report)', () => {
    expect(lastTwoReportRounds(1)).toEqual([1]);
  });

  it('is the previous round then this round from round 2 onward', () => {
    expect(lastTwoReportRounds(2)).toEqual([1, 2]);
    expect(lastTwoReportRounds(5)).toEqual([4, 5]);
  });
});

describe('composeConsolidatePrompt — single-sourced from the shared verdict vocabulary (§93)', () => {
  const catalog = ['review-plan-principal', 'review-plan-security'];
  const req = {
    recipeBody: '# plan-loop — consolidator\nJudge the round.',
    catalog,
    reportRels: ['.agent-terminal/loop/reports/1.md', '.agent-terminal/loop/reports/2.md'],
    outputRel: '.agent-terminal/loop/consolidate/2.md',
    round: 2,
    turnKey: 'consolidate-plan',
    doneRelPath: '.agent-terminal/loop/turn-done',
  };

  it('conveys the def consolidator recipe body', () => {
    expect(composeConsolidatePrompt(req)).toContain('Judge the round.');
  });

  it('names EXACTLY the last two reports as its inputs (AC2)', () => {
    const prompt = composeConsolidatePrompt(req);
    for (const rel of req.reportRels) expect(prompt).toContain(rel);
  });

  it('instructs writing the verdict output to the resolved output path', () => {
    expect(composeConsolidatePrompt(req)).toContain(req.outputRel);
  });

  it('conveys every verdict of the closed set and the catalog personas for the roster choice', () => {
    const prompt = composeConsolidatePrompt(req);
    for (const v of CONSOLIDATOR_VERDICTS) expect(prompt).toContain(v);
    for (const p of catalog) expect(prompt).toContain(p);
  });

  it('embeds a canonical example that is itself well-formed against the shared predicate (no prompt↔predicate drift)', () => {
    const prompt = composeConsolidatePrompt(req);
    // Slice the ACTUAL example the composer embedded and validate THAT — a drift in exampleConsolidatorOutput as
    // embedded (wrong label, a roster persona outside the catalog) must fail here, mirroring reviewTurn's pattern.
    const example = prompt.slice(prompt.indexOf('# Consolidator verdict'));
    expect(example).toContain('# Consolidator verdict');
    expect(consolidatorOutputWellFormed(example, catalog)).toBe(true);
  });

  it('ends with the shared done-signal instruction keyed to the consolidate turn, verifying the output first', () => {
    const prompt = composeConsolidatePrompt(req);
    expect(prompt).toContain('turn-done:consolidate-plan');
    expect(prompt).toContain(req.doneRelPath);
  });
});
