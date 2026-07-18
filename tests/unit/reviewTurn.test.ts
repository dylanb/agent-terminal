import { describe, expect, it } from 'vitest';
import { composeReviewAndFixPrompt, preReviewBoundaryCommand, reviewRosterWithCharters } from '../../src/main/reviewTurn';
import { DISPOSITIONS, REPORT_GRAMMAR, roundReportWellFormed } from '../../src/shared/roundReport';
import type { LoopDefV2 } from '../../src/main/loopDefV2';

// §27.3/§27.4/§27.5 — the pure, data-driven pieces of the §27 review-and-fix turn: the pre-review boundary
// selection (data from the def, never a hardcoded clear-or-compact choice), the roster (the def's full
// reviewer catalog), and the review-and-fix prompt — composed from the SHARED report vocabulary so the
// shape the fixer is told to write and the shape the predicate accepts derive from one source.

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

describe('preReviewBoundaryCommand — data-driven from the def (§27.7)', () => {
  it('issues the def-declared pre-review boundary (a compact carrying its message)', () => {
    expect(preReviewBoundaryCommand(def())).toBe('/compact Keep the plan and the ticket.');
  });

  it('defaults to /clear when the def declares no pre-review boundary', () => {
    expect(preReviewBoundaryCommand(def({ boundaries: [{ boundary: 'pre-work', mode: 'clear' }] }))).toBe('/clear');
  });
});

describe('reviewRosterWithCharters — the def\'s full reviewer catalog (§27.4, AC2)', () => {
  it('is every persona the def declares, in order, and never one it does not', () => {
    expect(reviewRosterWithCharters(def()).map((r) => r.persona)).toEqual(['review-plan-principal', 'review-plan-security']);
  });

  it('follows the def: a different catalog is a different roster', () => {
    const other = def({ reviewers: [{ persona: 'impl-review-tests', charter: '/c/t.md', tools: [] }] });
    expect(reviewRosterWithCharters(other).map((r) => r.persona)).toEqual(['impl-review-tests']);
  });

  it('the ONE production source carries each persona and its charter, in order', () => {
    expect(reviewRosterWithCharters(def())).toEqual([
      { persona: 'review-plan-principal', charter: '/tiers/plan-loop/charter/principal.md' },
      { persona: 'review-plan-security', charter: '/tiers/plan-loop/charter/security.md' },
    ]);
  });
});

describe('composeReviewAndFixPrompt — single-sourced from the shared report vocabulary (§27.5)', () => {
  const req = () => ({
    roster: def().reviewers.map((r) => ({ persona: r.persona, charter: r.charter })),
    sections: def().report.sections,
    reportRel: '.agent-terminal/loop/reports/1.md',
    round: 1,
    turnKey: 'review-plan',
    doneRelPath: '.agent-terminal/loop/turn-done',
  });

  it('names every roster persona and its charter reference', () => {
    const p = composeReviewAndFixPrompt(req());
    for (const r of def().reviewers) {
      expect(p).toContain(r.persona);
      expect(p).toContain(r.charter);
    }
  });

  it('tells the fixer exactly the closed disposition set the predicate accepts (one value, one spelling)', () => {
    const p = composeReviewAndFixPrompt(req());
    for (const d of DISPOSITIONS) expect(p).toContain(d);
  });

  it('tells the fixer exactly the per-issue element labels and empty marker the predicate requires', () => {
    const p = composeReviewAndFixPrompt(req());
    for (const label of [REPORT_GRAMMAR.issueLabel, REPORT_GRAMMAR.dispositionLabel, REPORT_GRAMMAR.reasonLabel, REPORT_GRAMMAR.whatChangedLabel]) {
      expect(p).toContain(label);
    }
    expect(p).toContain(REPORT_GRAMMAR.emptyMarker);
  });

  it('names the prescribed report sections and the round-keyed report location', () => {
    const p = composeReviewAndFixPrompt(req());
    for (const s of def().report.sections) expect(p).toContain(s);
    expect(p).toContain('.agent-terminal/loop/reports/1.md');
  });

  it('embeds a few-shot example that is itself well-formed against the predicate (no prompt↔predicate drift)', () => {
    const p = composeReviewAndFixPrompt(req());
    // The few-shot the prompt shows the fixer must validate against the same predicate that gates the turn,
    // or the fixer is instructed to write something the engine will reject.
    const spec = { sections: def().report.sections, roster: reviewRosterWithCharters(def()).map((r) => r.persona) };
    // The example is the whole trailing block after the marker line the composer emits before it.
    const example = p.slice(p.indexOf('# Round report'));
    expect(example).toContain('# Round report');
    expect(roundReportWellFormed(example, spec)).toBe(true);
  });

  it('ends by instructing the §27 done-file, verifying the report on disk first (§27.12a)', () => {
    const p = composeReviewAndFixPrompt(req());
    expect(p).toContain('turn-done:review-plan');
    expect(p).toContain('.agent-terminal/loop/turn-done');
    expect(p).toContain('.agent-terminal/loop/reports/1.md'); // the artifact to verify before signalling
  });
});
