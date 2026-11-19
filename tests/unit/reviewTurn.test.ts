import { describe, expect, it } from 'vitest';
import { catalogPersonas, composeReviewAndFixPrompt, preReviewBoundaryCommand, REVIEWER_HANDOFF_BEGIN, REVIEWER_HANDOFF_END, reviewRoster } from '../../src/main/reviewTurn';
import { phaseOutputRel } from '../../src/shared/phaseResult';
import type { LoopDefV2 } from '../../src/main/loopDefV2';

// §27.3/§27.4/§27.5 — the pure, data-driven pieces of the §27 review-and-fix turn: the pre-review boundary
// selection (data from the def, never a hardcoded clear-or-compact choice), the roster (the def's full
// reviewer catalog), and the review-and-fix prompt.

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

describe('composeReviewAndFixPrompt — what it carries from its inputs (§27.5)', () => {
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
      expect(p).toContain(`${r.loop}--${r.persona}`);
      expect(p).not.toContain(r.charter);
    }
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
  });

  it('names no artifact subject for a loop whose product is commits', () => {
    const p = composeReviewAndFixPrompt({ ...req(), ticket: 180 });
    expect(p).not.toMatch(/\.agent-terminal\/loop\/artifacts\/[^`\s]+\.md/);
    expect(p).not.toMatch(/SUBJECT —/);
    expect(p).not.toMatch(/not the issue body/i);
  });

  it('names the prescribed report sections and the round-keyed report location', () => {
    const p = composeReviewAndFixPrompt(req());
    for (const s of def().report.sections) expect(p).toContain(s);
    expect(p).toContain(req().reportRel);
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

  it('names each carried input by id and path', () => {
    const p = composeReviewAndFixPrompt({ ...req(), inputs: [PLAN, TICKET] });
    expect(p).toContain(`- plan: ${PLAN.rel}`);
    expect(p).toContain(`- groomed-ticket: ${TICKET.rel}`);
  });

  it('does not list the subject a second time as an input', () => {
    const p = composeReviewAndFixPrompt({ ...req(), inputs: [PLAN, TICKET], subjectRel: PLAN.rel });
    expect(p).not.toContain(`- plan: ${PLAN.rel}`);
    expect(p).toContain(`- groomed-ticket: ${TICKET.rel}`);
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

  it('tells the fixer to replace a wrong mechanism with its contract rather than detail it further', () => {
    expect(composeReviewAndFixPrompt(req('.agent-terminal/loop/artifacts/plan.md'))).toMatch(liftClause);
  });

  it('carries no such clause for a loop whose product is commits, where the mechanism is the work', () => {
    expect(composeReviewAndFixPrompt(req())).not.toMatch(liftClause);
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

  it('carries the operator feedback verbatim when present', () => {
    const p = composeReviewAndFixPrompt(reqWith('Tighten the migration section; it overspecifies the schema.'));
    expect(p).toContain('Tighten the migration section; it overspecifies the schema.');
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

  it('still carries the done-signal instruction — feedback never displaces the turn contract', () => {
    const p = composeReviewAndFixPrompt(reqWith('address the taint flow'));
    expect(p).toContain('turn-done:review-plan');
    expect(p).toContain('.agent-terminal/loop/reports/2.json');
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
  const RESULT_REL = '.agent-terminal/loop/refactor-results/1.json';
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
    expect(p).toContain(refactorReq().reportRel); // the report is still written
  });

  it('appends the phase-result block naming the result file and its output file', () => {
    const p = composeReviewAndFixPrompt(refactorReq());
    expect(p).toContain(RESULT_REL);
    expect(p).toContain(phaseOutputRel(RESULT_REL));
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
    expect(p).not.toContain(phaseOutputRel(RESULT_REL)); // no phase-result section
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

  it('carries the brief verbatim', () => {
    const p = composeReviewAndFixPrompt({ ...req(), loopBrief: BRIEF });
    expect(p).toContain(BRIEF);
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

  it('names the ticket and how to read it', () => {
    expect(handoff(composeReviewAndFixPrompt({ ...req(), ticket: 180 }))).toContain('gh issue view 180 --comments');
  });

  it('for a commits loop, says how to see the change with git and which slice the round covers', () => {
    const h = handoff(composeReviewAndFixPrompt({ ...req(), slice: 2 }));
    expect(h).toContain('git diff HEAD');
    expect(h).toContain('impl-slice 2');
  });

  it('for a file-artifact loop, names the subject to grade instead of the code', () => {
    const subject = '.agent-terminal/loop/artifacts/plan.md';
    const h = handoff(composeReviewAndFixPrompt({ ...req(), ticket: 180, subjectRel: subject }));
    expect(h).toMatch(new RegExp(`Grade ${subject.replace(/\./g, '\\.')}`));
    expect(h).not.toContain('git diff HEAD');
  });

  it('lists the carried inputs', () => {
    const h = handoff(composeReviewAndFixPrompt({ ...req(), inputs: [{ id: 'plan', rel: '.agent-terminal/loop/artifacts/plan.md' }] }));
    expect(h).toContain('- plan: .agent-terminal/loop/artifacts/plan.md');
  });

});

describe('composeReviewAndFixPrompt: a deciding step is told where its decision goes', () => {
  const base = {
    roster: reviewRoster(def()),
    sections: def().report.sections,
    reportRel: '.agent-terminal/loop/reports/2.json',
    round: 2,
    turnKey: 'review-triage',
    doneRelPath: '.agent-terminal/loop/turn-done',
    agentKind: 'claude-code' as const,
  };
  const decision = { rel: '.agent-terminal/loop/artifacts/d.json', values: ['confirmed', 'rejected'], checkCommand: 'DECISION-CHECK-CMD' };

  it("a deciding round's prompt names its decision file, each value and the check command", () => {
    const prompt = composeReviewAndFixPrompt({ ...base, decision });
    expect(prompt).toContain(decision.rel);
    expect(prompt).toContain('confirmed');
    expect(prompt).toContain('rejected');
    expect(prompt).toContain('DECISION-CHECK-CMD');
  });

  it('a round with no decision names no decision file and no decision check', () => {
    const prompt = composeReviewAndFixPrompt(base);
    expect(prompt).not.toContain(decision.rel);
    expect(prompt).not.toContain('DECISION-CHECK-CMD');
  });
});
