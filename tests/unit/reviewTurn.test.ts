import { describe, expect, it } from 'vitest';
import { composeAppWorkPrompt } from '../../src/main/appWorkTurn';
import { catalogPersonas, composeReviewAndFixPrompt, preReviewBoundaryCommand, REVIEWER_HANDOFF_BEGIN, REVIEWER_HANDOFF_END, reviewRoster } from '../../src/main/reviewTurn';
import { DISPOSITIONS, REPORT_FIELDS, REVIEWER_STATUSES, roundReportWellFormed } from '../../src/shared/roundReport';
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
    rounds: { kind: 'engine', consolidator: '/tiers/plan-loop/prompts/consolidate.md' },
    boundaries: [
      { boundary: 'pre-work', mode: 'clear' },
      { boundary: 'pre-review', mode: 'compact', message: 'Keep the plan and the ticket.' },
    ],
    report: { sections: ['summary', 'findings', 'disposition'], polish: 'fix' },
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

  it('the ONE production source carries each persona, its charter and tools, and the sub-agent installed for it, in order', () => {
    expect(reviewRoster(def())).toEqual([
      { loop: 'plan-loop', persona: 'review-plan-principal', charter: '/tiers/plan-loop/charter/principal.md', tools: ['Read'] },
      { loop: 'plan-loop', persona: 'review-plan-security', charter: '/tiers/plan-loop/charter/security.md', tools: ['Read', 'Bash'] },
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
    roster: reviewRoster(def()),
    sections: def().report.sections,
    reportRel: '.agent-terminal/loop/reports/1.json',
    round: 1,
    turnKey: 'review-plan',
    doneRelPath: '.agent-terminal/loop/turn-done',
    agentKind: 'claude-code' as const,
  });

  it('names every roster persona by the sub-agent type that carries its charter, and never hands over a charter path', () => {
    const p = composeReviewAndFixPrompt(req());
    for (const r of reviewRoster(def())) {
      expect(p).toContain(`${r.persona} — subagent_type: ${r.loop}--${r.persona}`);
      expect(p).not.toContain(r.charter);
    }
  });

  it('tells the fixer to record a reviewer whose sub-agent type cannot be found as not loaded', () => {
    expect(composeReviewAndFixPrompt(req())).toMatch(/"not loaded"` for one whose\s+subagent_type the Task tool cannot find/);
  });

  it('requires that exact sub-agent type, never a substitute, for each reviewer', () => {
    const p = composeReviewAndFixPrompt(req());
    expect(p).toMatch(/exactly that subagent_type/i);
    expect(p).toMatch(/never (substitute|spawn) .*general-purpose/i);
  });

  it('§19.1 — binds the turn to the engine-resolved ticket it hands each reviewer', () => {
    expect(composeReviewAndFixPrompt({ ...req(), ticket: 133 })).toContain('working GitHub issue #133');
    expect(composeReviewAndFixPrompt(req())).not.toContain('this loop is working GitHub issue'); // absent when none resolved
  });

  // §27.4 — a loop whose work turn produces a file artifact is reviewing THAT file: the issue body on GitHub
  // still holds the pre-work text until the gate's side-effect writes the artifact back, so a reviewer that
  // grades the issue re-raises findings the artifact already fixed.
  it('names the loop\'s work artifact as the subject each reviewer grades, not the live issue body', () => {
    const subject = '.agent-terminal/loop/artifacts/groomed-ticket.md';
    const p = composeReviewAndFixPrompt({ ...req(), ticket: 180, subjectRel: subject });
    expect(p).toMatch(/grade .*groomed-ticket\.md.*not the issue body/is);
    expect(p).not.toContain('handing each ONLY the ticket and its charter');
  });

  it('names no artifact subject for a loop whose product is commits', () => {
    const p = composeReviewAndFixPrompt({ ...req(), ticket: 180 });
    expect(p).not.toMatch(/\.agent-terminal\/loop\/artifacts\/[^`\s]+\.md/);
    expect(p).not.toMatch(/SUBJECT —/);
    expect(p).not.toMatch(/not the issue body/i);
  });

  it('tells the fixer exactly the closed disposition set the predicate accepts (one value, one spelling)', () => {
    const p = composeReviewAndFixPrompt(req());
    for (const d of DISPOSITIONS) expect(p).toContain(d);
  });

  it('tells the fixer exactly the JSON fields the predicate requires', () => {
    const p = composeReviewAndFixPrompt(req());
    for (const key of Object.values(REPORT_FIELDS)) expect(p).toContain(`"${key}"`);
  });

  it('tells the fixer each reviewer status, so a reviewer that FAILED TO RUN is recorded apart from one that found nothing (§27.5/AC7)', () => {
    const p = composeReviewAndFixPrompt(req());
    for (const status of REVIEWER_STATUSES) expect(p).toContain(`"${status}"`);
    expect(p).toMatch(/"failed"` for one\s+that FAILED to run/);
  });

  it('names the prescribed report sections and the round-keyed report location', () => {
    const p = composeReviewAndFixPrompt(req());
    for (const s of def().report.sections) expect(p).toContain(s);
    expect(p).toContain(req().reportRel);
  });

  it('embeds a few-shot example that is itself well-formed against the predicate (no prompt↔predicate drift)', () => {
    const p = composeReviewAndFixPrompt(req());
    // The few-shot the prompt shows the fixer must validate against the same predicate that gates the turn,
    // or the fixer is instructed to write something the engine will reject.
    const spec = { sections: def().report.sections, roster: reviewRoster(def()).map((r) => r.persona) };
    // The example is the whole trailing block after the line the composer emits before it.
    const lead = 'A well-formed example:';
    expect(p).toContain(lead);
    expect(roundReportWellFormed(p.slice(p.indexOf(lead) + lead.length), spec)).toBe(true);
  });

  it('ends by instructing the §27 done-file, verifying the report on disk first (§27.12a)', () => {
    const p = composeReviewAndFixPrompt(req());
    expect(p).toContain('turn-done:review-plan');
    expect(p).toContain('.agent-terminal/loop/turn-done');
    expect(p).toContain(req().reportRel); // the artifact to verify before signalling
  });
});

// §27.4
describe('composeReviewAndFixPrompt — the flow documents and the carried inputs (§27.4)', () => {
  const req = () => ({
    roster: reviewRoster(def()),
    sections: def().report.sections,
    reportRel: '.agent-terminal/loop/reports/1.json',
    round: 1,
    turnKey: 'review-green',
    doneRelPath: '.agent-terminal/loop/turn-done',
    agentKind: 'claude-code' as const,
  });
  const PLAN = { id: 'plan', rel: '.agent-terminal/loop/artifacts/plan.md' };
  const TICKET = { id: 'groomed-ticket', rel: '.agent-terminal/loop/artifacts/groomed-ticket.md' };

  it('names each carried input by id and path, and no longer says reviewers get no plan', () => {
    const p = composeReviewAndFixPrompt({ ...req(), inputs: [PLAN, TICKET] });
    expect(p).toContain(`- plan: ${PLAN.rel}`);
    expect(p).toContain(`- groomed-ticket: ${TICKET.rel}`);
    expect(p).not.toMatch(/no plan/i);
  });

  it('does not list the subject a second time as an input', () => {
    const p = composeReviewAndFixPrompt({ ...req(), inputs: [PLAN, TICKET], subjectRel: PLAN.rel });
    expect(p).not.toContain(`- plan: ${PLAN.rel}`);
    expect(p).toContain(`- groomed-ticket: ${TICKET.rel}`);
  });

  it('says flow documents live only under the loop artifacts directory, and carves out the code and repo standards', () => {
    for (const p of [composeReviewAndFixPrompt(req()), composeReviewAndFixPrompt({ ...req(), subjectRel: PLAN.rel })]) {
      expect(p).toMatch(/flow documents[\s\S]*only under `\.agent-terminal\/loop\/artifacts\/`/i);
      expect(p).toMatch(/elsewhere in the repository is not one of this work's flow documents/i);
      expect(p).toMatch(/still work when the ticket names it/i);
      expect(p).not.toMatch(/ignore it/i);
      expect(p).toMatch(/working-tree diff/i);
      expect(p).toMatch(/standards and\s+configuration are read where they live/i);
    }
  });
});

// §27.6 — the materiality floor that lets the termination rule reach a fixed point on PROSE. §27.6's
// convergence argument (a memory-less fixer "re-dismisses a settled judgment every round … the loop
// terminates when a round produces no changes") holds only if an in-scope finding that changes no
// observable outcome is DISMISSED, not fixed — fixing an already-correct artifact for an equivalent
// refinement is what manufactures the next round's findings. The composer must state that criterion.
describe('composeReviewAndFixPrompt — materiality floor for convergence (§27.6)', () => {
  const req = () => ({
    roster: reviewRoster(def()),
    sections: def().report.sections,
    reportRel: '.agent-terminal/loop/reports/1.json',
    round: 1,
    turnKey: 'review-plan',
    doneRelPath: '.agent-terminal/loop/turn-done',
    agentKind: 'claude-code' as const,
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

  const doubleFidelityClause =
    /(fake|stand-in|double)[\s\S]*only\s+when\s+a\s+test\s+the\s+ticket\s+needs\s+relies\s+on[\s\S]*`dismissed — invalid`/i;

  it('dismisses a test double gap that no test the ticket needs relies on, for a commit loop', () => {
    expect(composeReviewAndFixPrompt(req())).toMatch(doubleFidelityClause);
  });

  it('dismisses a test double gap that no test the ticket needs relies on, for a document loop', () => {
    expect(composeReviewAndFixPrompt({ ...req(), subjectRel: '.agent-terminal/loop/artifacts/plan.md' })).toMatch(
      doubleFidelityClause,
    );
  });
});

// §27.3 — a fixer that corrects a wrong mechanism in a document by specifying it in more detail hands the next
// round new surface to review: #180's plan-bundle ran ten rounds that way, every fix adding mechanism.
describe('composeReviewAndFixPrompt — fixing a document subject lifts, never adds (§27.3)', () => {
  const req = (subjectRel?: string) => ({
    roster: reviewRoster(def()),
    sections: def().report.sections,
    reportRel: '.agent-terminal/loop/reports/1.json',
    round: 1,
    turnKey: 'review-plan',
    doneRelPath: '.agent-terminal/loop/turn-done',
    agentKind: 'claude-code' as const,
    ...(subjectRel !== undefined ? { subjectRel } : {}),
  });
  const liftClause = /replac\w*\s+(that|the)\s+mechanism\s+with\s+the\s+contract\s+it\s+must\s+meet[\s\S]*never\s+by\s+specifying/i;
  const overreachClause = /no\s+acceptance\s+criterion\s+names[\s\S]*`needs a human`/i;

  it('tells the fixer to replace a wrong mechanism with its contract rather than detail it further', () => {
    expect(composeReviewAndFixPrompt(req('.agent-terminal/loop/artifacts/plan.md'))).toMatch(liftClause);
  });

  it('routes a fix that needs a state, outcome, field or defence no acceptance criterion names to a human', () => {
    expect(composeReviewAndFixPrompt(req('.agent-terminal/loop/artifacts/plan.md'))).toMatch(overreachClause);
  });

  const assumptionClause = /no\s+test\s+environment\s+in\s+the\s+repository\s+exercises[\s\S]*Assumptions/i;
  const sameGuardClause = /another\s+hole\s+in\s+the\s+same[\s\S]*`needs a human`/i;

  it('records behaviour no test environment exercises as an assumption rather than elaborating it', () => {
    expect(composeReviewAndFixPrompt(req('.agent-terminal/loop/artifacts/plan.md'))).toMatch(assumptionClause);
  });

  it('routes another hole in the same guard to a human as a sign the mechanism is wrong', () => {
    expect(composeReviewAndFixPrompt(req('.agent-terminal/loop/artifacts/plan.md'))).toMatch(sameGuardClause);
  });

  it('carries none of these clauses for a loop whose product is commits, where the mechanism is the work', () => {
    const p = composeReviewAndFixPrompt(req());
    for (const clause of [liftClause, overreachClause, assumptionClause, sameGuardClause]) expect(p).not.toMatch(clause);
  });
});

describe('composeReviewAndFixPrompt — deferred polish (§27.6/§27.8)', () => {
  const req = (polish?: 'fix' | 'defer') => ({
    roster: reviewRoster(def()),
    sections: def().report.sections,
    reportRel: '.agent-terminal/loop/reports/1.json',
    round: 1,
    turnKey: 'review-green',
    doneRelPath: '.agent-terminal/loop/turn-done',
    agentKind: 'claude-code' as const,
    ...(polish !== undefined ? { polish } : {}),
  });
  const deferClause = /polish[\s\S]*`dismissed — out of scope`[\s\S]*later loop/i;

  it('tells the fixer to dismiss polish-only findings as out of scope when the def defers polish', () => {
    expect(composeReviewAndFixPrompt(req('defer'))).toMatch(deferClause);
  });

  it('names no particular later loop, since more than one loop defers to different ones', () => {
    expect(composeReviewAndFixPrompt(req('defer'))).not.toMatch(/integration-slice/i);
  });

  it('carries no deferral clause when the def fixes polish', () => {
    expect(composeReviewAndFixPrompt(req('fix'))).not.toMatch(deferClause);
    expect(composeReviewAndFixPrompt(req())).not.toMatch(deferClause);
  });
});

// §27.9/§19.4 / N5 (AC4) — a request-changes decision delivers the operator's feedback into the NEXT
// review-and-fix round, "alongside the reviewers' findings." The composer carries it as an optional block; the
// engine threads it from the run-state a request-changes wrote. Absent feedback leaves the round unchanged.
describe('composeReviewAndFixPrompt — human request-changes feedback (§27.9 / AC4)', () => {
  const reqWith = (feedback?: string) => ({
    roster: reviewRoster(def()),
    sections: def().report.sections,
    reportRel: '.agent-terminal/loop/reports/2.json',
    round: 2,
    turnKey: 'review-plan',
    doneRelPath: '.agent-terminal/loop/turn-done',
    agentKind: 'claude-code' as const,
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
    expect(p).toContain('.agent-terminal/loop/reports/2.json');
    // The few-shot example still trails so the fixer sees the well-formed report shape.
    expect(p).toContain('A well-formed example:');
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
    roster: reviewRoster(def()),
    sections: def().report.sections,
    reportRel: '.agent-terminal/loop/reports/1.json',
    round: 1,
    turnKey: 'review-plan',
    doneRelPath: '.agent-terminal/loop/turn-done',
    agentKind: 'claude-code' as const,
    resultRel: RESULT_REL,
  });

  it('still instructs the round report (the review round is not replaced — the result is ADDED)', () => {
    const p = composeReviewAndFixPrompt(refactorReq());
    for (const s of def().report.sections) expect(p).toContain(s);
    for (const d of DISPOSITIONS) expect(p).toContain(d);
    expect(p).toContain(refactorReq().reportRel); // the report is still written
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

  it('verifies BOTH the round report and the result on disk before the done-signal — the round gate reads both', () => {
    const p = composeReviewAndFixPrompt(refactorReq());
    const verify = p.slice(p.indexOf('FIRST confirm'), p.indexOf('turn-done:review-plan'));
    expect(verify).toContain(RESULT_REL);
    expect(verify).toContain('.agent-terminal/loop/reports/1.json');
  });

  it('adds NO phase-result block when resultRel is absent (RED/GREEN loops\' review rounds are unchanged)', () => {
    const { resultRel: _drop, ...withoutResult } = refactorReq();
    const p = composeReviewAndFixPrompt(withoutResult);
    expect(p).not.toContain(RESULT_REL);
    expect(p).not.toContain(PHASE_RESULT_GRAMMAR.capturedOutputHeading); // no phase-result section
    expect(p).not.toContain('Run the test command for this change and classify'); // no classify instruction
    // the plain review round still verifies the REPORT on disk (unchanged)
    expect(p).toContain('re-read .agent-terminal/loop/reports/1.json');
  });
});

describe('composeReviewAndFixPrompt — the loop brief binds every fix (§27.3)', () => {
  const req = () => ({
    roster: reviewRoster(def()),
    sections: def().report.sections,
    reportRel: '.agent-terminal/loop/reports/1.json',
    round: 1,
    turnKey: 'review-plan',
    doneRelPath: '.agent-terminal/loop/turn-done',
    agentKind: 'claude-code' as const,
  });
  const BRIEF = 'You are a principal engineer.\n\nNo acceptance criterion may be deferred.';

  it('carries the brief verbatim as the standing instructions every fix must meet', () => {
    const p = composeReviewAndFixPrompt({ ...req(), loopBrief: BRIEF });
    expect(p).toContain(BRIEF);
    expect(p).toMatch(/every fix/i);
  });

  it('routes a fix that needs the operator to needs a human rather than re-running the work turn\'s steps', () => {
    const p = composeReviewAndFixPrompt({ ...req(), loopBrief: BRIEF });
    const block = p.slice(p.indexOf(BRIEF) - 600, p.indexOf(BRIEF));
    expect(block).toContain(`\`${'needs a human'}\``);
  });

  it('carries no brief block when the loop declares none', () => {
    const p = composeReviewAndFixPrompt(req());
    expect(p).not.toMatch(/standing instructions/i);
  });
});

describe('composeReviewAndFixPrompt — the engine writes the reviewer hand-off (§27.4)', () => {
  const req = () => ({
    roster: reviewRoster(def()),
    sections: def().report.sections,
    reportRel: '.agent-terminal/loop/reports/1.json',
    round: 1,
    turnKey: 'review-green',
    doneRelPath: '.agent-terminal/loop/turn-done',
    agentKind: 'claude-code' as const,
  });
  const handoff = (p: string): string => {
    const start = p.indexOf(REVIEWER_HANDOFF_BEGIN);
    const end = p.indexOf(REVIEWER_HANDOFF_END);
    expect(start, 'no hand-off block').toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    return p.slice(start + REVIEWER_HANDOFF_BEGIN.length, end);
  };

  it('tells the fixer to pass the hand-off to each reviewer word for word, adding nothing', () => {
    const p = composeReviewAndFixPrompt(req());
    handoff(p);
    expect(p).toMatch(/word for word/i);
  });

  it('names the ticket and how to read it', () => {
    expect(handoff(composeReviewAndFixPrompt({ ...req(), ticket: 180 }))).toContain('gh issue view 180 --comments');
  });

  it('for a commits loop, says how to see the change with git and which slice the round covers', () => {
    const h = handoff(composeReviewAndFixPrompt({ ...req(), slice: 2 }));
    expect(h).toContain('git status');
    expect(h).toContain('git diff HEAD');
    expect(h).toMatch(/default branch/);
    expect(h).toContain('impl-slice 2');
  });

  it('for a file-artifact loop, names the subject to grade instead of the code', () => {
    const subject = '.agent-terminal/loop/artifacts/plan.md';
    const h = handoff(composeReviewAndFixPrompt({ ...req(), ticket: 180, subjectRel: subject }));
    expect(h).toMatch(new RegExp(`Grade ${subject.replace(/\./g, '\\.')}`));
    expect(h).not.toContain('git diff HEAD');
  });

  it('lists the carried inputs and where the flow documents live', () => {
    const h = handoff(composeReviewAndFixPrompt({ ...req(), inputs: [{ id: 'plan', rel: '.agent-terminal/loop/artifacts/plan.md' }] }));
    expect(h).toContain('- plan: .agent-terminal/loop/artifacts/plan.md');
    expect(h).toMatch(/only under `\.agent-terminal\/loop\/artifacts\/`/);
  });

  it('describes the change under review one way only', () => {
    const h = handoff(composeReviewAndFixPrompt(req()));
    expect(h).not.toMatch(/working-tree diff/);
    expect(h).toMatch(/standards and\s+configuration are read where they live/);
  });

  it('asks for each finding as file:line, issue, consequence and fix, with no severity, and no file changes', () => {
    const h = handoff(composeReviewAndFixPrompt(req()));
    expect(h).toMatch(/file:line, the issue, its concrete consequence, and the fix/);
    expect(h).toMatch(/do not rate severity/i);
    expect(h).toContain('no findings');
    expect(h).toMatch(/do not change any file/i);
  });
});

// §27.3/§27.6 (v2.202) — a fixer that patches one more special case into a parser for a format the repository
// itself defines is how #208 spent rounds on a Markdown grammar: every finding was new, so §27.6's spinning
// check never fired. The fixer and the work agent are both told to question the format first.
describe('the format design check, before patching a parser (§27.3/§27.6 v2.202)', () => {
  const req = () => ({
    roster: reviewRoster(def()),
    sections: def().report.sections,
    reportRel: '.agent-terminal/loop/reports/1.json',
    round: 1,
    turnKey: 'review-plan',
    doneRelPath: '.agent-terminal/loop/turn-done',
    agentKind: 'claude-code' as const,
  });
  const work = { recipeBody: '# work turn', turnKey: 'work-x', doneRelPath: '.agent-terminal/loop/turn-done', completion: null };
  const asks = /special case[\s\S]*format this repository defines[\s\S]*changing the format would remove/i;

  it('asks the fixer whether changing the format would remove the case, and to say why when it patches', () => {
    const p = composeReviewAndFixPrompt(req());
    expect(p).toMatch(asks);
    expect(p).toMatch(/say why/i);
  });

  it('asks the work agent the same, in the same words', () => {
    const block = (p: string): string => {
      const m = asks.exec(p);
      if (m === null) throw new Error('no design check');
      return p.slice(p.lastIndexOf('\n\n', m.index), p.indexOf('\n\n', m.index + m[0].length));
    };
    expect(block(composeAppWorkPrompt(work))).toBe(block(composeReviewAndFixPrompt(req())));
  });
});
