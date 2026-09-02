import { describe, expect, it } from 'vitest';
import { catalogPersonas, composeReviewAndFixPrompt, preReviewBoundaryCommand, reviewRoster } from '../../src/main/reviewTurn';
import { DISPOSITIONS, REPORT_GRAMMAR, roundReportWellFormed } from '../../src/shared/roundReport';
import { PHASE_OUTCOMES, REFACTOR_COMPLETING_OUTCOME } from '../../src/shared/phaseOutcome';
import { BUILD_OUTCOMES } from '../../src/shared/buildOutcome';
import { PHASE_RESULT_GRAMMAR, examplePhaseResult } from '../../src/shared/phaseResult';
import type { LoopDefV2 } from '../../src/main/loopDefV2';

// §27.3/§27.4/§27.5 — the pure, data-driven pieces of the §27 review-and-fix turn: the pre-review boundary
// selection (data from the def, never a hardcoded clear-or-compact choice), the roster (the def's full
// reviewer catalog), and the review-and-fix prompt — composed from the SHARED report vocabulary so the
// shape the fixer is told to write and the shape the predicate accepts derive from one source.

function def(over: Partial<LoopDefV2> = {}): LoopDefV2 {
  return {
    version: 'v2',
    name: 'plan-loop',
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
    pickup: { initialStatus: 'planning', branchTemplate: 'plan-loop/issue-{issue}', initialLabels: [], wipe: { mode: 'abort' } },
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

describe('reviewRoster — the def\'s full reviewer catalog (§27.4, AC2)', () => {
  it('is every persona the def declares, in order, and never one it does not', () => {
    expect(reviewRoster(def()).map((r) => r.persona)).toEqual(['review-plan-principal', 'review-plan-security']);
  });

  it('follows the def: a different catalog is a different roster', () => {
    const other = def({ reviewers: [{ persona: 'impl-review-tests', charter: '/c/t.md', tools: [] }] });
    expect(reviewRoster(other).map((r) => r.persona)).toEqual(['impl-review-tests']);
  });

  it('the ONE production source carries each persona and its charter, in order', () => {
    expect(reviewRoster(def())).toEqual([
      { persona: 'review-plan-principal', charter: '/tiers/plan-loop/charter/principal.md' },
      { persona: 'review-plan-security', charter: '/tiers/plan-loop/charter/security.md' },
    ]);
  });
});

// §27.4 / CLAUDE.md shared-semantics — the def's catalog-persona projection lives in ONE place, so the panel
// display, the consolidator's validation catalog, and the round roster cannot drift on which personas the def
// declares.
describe('catalogPersonas — the ONE catalog-persona projection (§27.4)', () => {
  it('is every persona the def declares, in order, and matches reviewRoster\'s persona projection', () => {
    expect(catalogPersonas(def())).toEqual(['review-plan-principal', 'review-plan-security']);
    expect(catalogPersonas(def())).toEqual(reviewRoster(def()).map((r) => r.persona));
  });

  it('follows the def: a different catalog is a different projection', () => {
    const other = def({ reviewers: [{ persona: 'impl-review-tests', charter: '/c/t.md', tools: [] }] });
    expect(catalogPersonas(other)).toEqual(['impl-review-tests']);
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

  it('instructs the failed marker for a reviewer that FAILED TO RUN, distinct from the empty marker (§27.5/AC7)', () => {
    // §27.5/v2.137 — a lens that failed to run must be recorded DISTINCTLY from one that ran and found
    // nothing; the failed marker is the signal the consolidator's clean-guard keys on, so the prompt must
    // name it (single-sourced from the grammar) rather than telling the fixer both carry the empty marker.
    const p = composeReviewAndFixPrompt(req());
    expect(p).toContain(REPORT_GRAMMAR.failedMarker);
    expect(REPORT_GRAMMAR.failedMarker).not.toBe(REPORT_GRAMMAR.emptyMarker);
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
    const spec = { sections: def().report.sections, roster: reviewRoster(def()).map((r) => r.persona) };
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

// §27.6 — the materiality floor that lets the termination rule reach a fixed point on PROSE. §27.6's
// convergence argument (a memory-less fixer "re-dismisses a settled judgment every round … the loop
// terminates when a round produces no changes") holds only if an in-scope finding that changes no
// observable outcome is DISMISSED, not fixed — fixing an already-correct artifact for an equivalent
// refinement is what manufactures the next round's findings. The composer must state that criterion.
describe('composeReviewAndFixPrompt — materiality floor for convergence (§27.6)', () => {
  const req = () => ({
    roster: def().reviewers.map((r) => ({ persona: r.persona, charter: r.charter })),
    sections: def().report.sections,
    reportRel: '.agent-terminal/loop/reports/1.md',
    round: 1,
    turnKey: 'review-plan',
    doneRelPath: '.agent-terminal/loop/turn-done',
  });

  it('tells the fixer to fix only an issue that changes an observable outcome', () => {
    expect(composeReviewAndFixPrompt(req())).toContain('observable outcome');
  });

  it('tells the fixer that an already-correct refinement is dismissed, not fixed (so a round can reach no-change)', () => {
    const p = composeReviewAndFixPrompt(req());
    expect(p.toLowerCase()).toContain('already correct');
    // it names the dismissal disposition for such a refinement — never `fixed`
    expect(p).toContain('dismissed — invalid');
  });
});

// §27.9/§19.4 / N5 (AC4) — a request-changes decision delivers the operator's feedback into the NEXT
// review-and-fix round, "alongside the reviewers' findings." The composer carries it as an optional block; the
// engine threads it from the run-state a request-changes wrote. Absent feedback leaves the round unchanged.
describe('composeReviewAndFixPrompt — human request-changes feedback (§27.9 / AC4)', () => {
  const reqWith = (feedback?: string) => ({
    roster: def().reviewers.map((r) => ({ persona: r.persona, charter: r.charter })),
    sections: def().report.sections,
    reportRel: '.agent-terminal/loop/reports/2.md',
    round: 2,
    turnKey: 'review-plan',
    doneRelPath: '.agent-terminal/loop/turn-done',
    ...(feedback !== undefined ? { feedback } : {}),
  });

  it('carries the operator feedback verbatim when present, framed alongside the reviewers\' findings', () => {
    const p = composeReviewAndFixPrompt(reqWith('Tighten the migration section; it overspecifies the schema.'));
    expect(p).toContain('Tighten the migration section; it overspecifies the schema.');
    // The block names it as the human's request-changes feedback, not a reviewer finding, so the fixer weighs
    // it as a first-class input to this round (§27.9).
    expect(p.toLowerCase()).toContain('feedback');
  });

  it('adds no feedback block when the round carries none (a consolidator-driven another-round is unchanged)', () => {
    const withFb = composeReviewAndFixPrompt(reqWith('do the thing'));
    const without = composeReviewAndFixPrompt(reqWith());
    expect(without).not.toContain('do the thing');
    // The no-feedback prompt is exactly the base review-and-fix prompt (no empty block, no dangling header).
    expect(without.length).toBeLessThan(withFb.length);
  });

  it('a whitespace-only feedback string is treated as no feedback (never a blank block)', () => {
    const p = composeReviewAndFixPrompt(reqWith('   \n  '));
    const without = composeReviewAndFixPrompt(reqWith());
    expect(p).toBe(without);
  });

  it('still carries the done-signal instruction and the well-formed example — feedback never displaces the turn contract', () => {
    const p = composeReviewAndFixPrompt(reqWith('address the taint flow'));
    expect(p).toContain('turn-done:review-plan');
    expect(p).toContain('.agent-terminal/loop/reports/2.md');
    // The few-shot example still trails so the fixer sees the well-formed report shape.
    expect(p).toContain('# Round report');
    // The feedback appears BEFORE the done-signal contract, not after the example.
    expect(p.indexOf('address the taint flow')).toBeLessThan(p.indexOf('turn-done:review-plan'));
  });
});

// §28.5.3 / S5 — the REFACTOR review round: the fixer additionally runs the targeted tests and writes a
// phase-result file the round gate reads, so the round completes only when the tests still pass. The review
// prompt gains an optional `resultRel`; when present it appends the shared phase-result WRITER block (softer
// than GREEN — no build classification) after the report block, and verifies the RESULT on disk before the
// done-file. Absent `resultRel`, the prompt is the pre-S5 review prompt (RED/GREEN loops' review rounds unchanged).
describe('composeReviewAndFixPrompt — the refactor round phase-result instruction (§28.5.3)', () => {
  const RESULT_REL = '.agent-terminal/loop/artifacts/refactor-result-1.md';
  const refactorReq = () => ({
    roster: def().reviewers.map((r) => ({ persona: r.persona, charter: r.charter })),
    sections: def().report.sections,
    reportRel: '.agent-terminal/loop/reports/1.md',
    round: 1,
    turnKey: 'review-plan',
    doneRelPath: '.agent-terminal/loop/turn-done',
    resultRel: RESULT_REL,
  });

  it('still instructs the round report (the review round is not replaced — the result is ADDED)', () => {
    const p = composeReviewAndFixPrompt(refactorReq());
    for (const s of def().report.sections) expect(p).toContain(s);
    for (const d of DISPOSITIONS) expect(p).toContain(d);
    expect(p).toContain('.agent-terminal/loop/reports/1.md'); // the report is still written
  });

  it('appends the phase-result WRITER block naming the result file, the outcome vocabulary, and the passed few-shot', () => {
    const p = composeReviewAndFixPrompt(refactorReq());
    expect(p).toContain(RESULT_REL);
    expect(p).toContain(PHASE_RESULT_GRAMMAR.outcomeLabel);
    expect(p).toContain(PHASE_RESULT_GRAMMAR.capturedOutputHeading);
    for (const outcome of PHASE_OUTCOMES) expect(p).toContain(outcome);
    expect(p).toContain(examplePhaseResult(REFACTOR_COMPLETING_OUTCOME).trimEnd());
  });

  it('is SOFTER than GREEN — no build classification (§28.5.3: refactor gates on {passed}, not build)', () => {
    const p = composeReviewAndFixPrompt(refactorReq());
    expect(p).not.toContain(`${PHASE_RESULT_GRAMMAR.buildLabel}:`);
    for (const b of BUILD_OUTCOMES) expect(p).not.toContain(b);
  });

  it('verifies the RESULT file on disk before the done-signal (the new, more-likely-forgotten artifact)', () => {
    const p = composeReviewAndFixPrompt(refactorReq());
    expect(p).toContain(`re-read ${RESULT_REL}`); // the done-signal verify targets the result rel
    expect(p).toContain('turn-done:review-plan');
  });

  it('adds NO phase-result block when resultRel is absent (RED/GREEN loops\' review rounds are unchanged)', () => {
    const { resultRel: _drop, ...withoutResult } = refactorReq();
    const p = composeReviewAndFixPrompt(withoutResult);
    expect(p).not.toContain(RESULT_REL);
    expect(p).not.toContain(PHASE_RESULT_GRAMMAR.capturedOutputHeading); // no phase-result section
    expect(p).not.toContain('Run the test command for this change and classify'); // no classify instruction
    // the plain review round still verifies the REPORT on disk (unchanged)
    expect(p).toContain('re-read .agent-terminal/loop/reports/1.md');
  });
});
