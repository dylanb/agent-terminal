import { describe, expect, it } from 'vitest';
import { composeAppWorkPrompt, flowDocumentLines } from '../../src/main/appWorkTurn';
import { composeReviewAndFixPrompt, reviewerHandoffLines } from '../../src/main/reviewTurn';
import { composeConsolidatePrompt } from '../../src/main/consolidateTurn';
import type { AdoptedRunRefs } from '../../src/shared/currentTicket';

// #304 AC 6, 7 — every prompt an adopting run sends names every ticket the reviewed PR closes as intent, read
// through gh against its own repository, names the reviewed PR, and presents the change as the range from the
// recorded merge-base to the fix branch, never as the working-tree diff or the branch's commits since it left the
// default branch.

const HOST = 'github.example.com';
const ADOPTION: AdoptedRunRefs = {
  pr: 4242,
  host: HOST,
  tickets: [
    { repo: 'owner/repo', number: 176 },
    { repo: 'contributor/fork', number: 177 },
  ],
  baseOid: 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0',
  // Holds no PR number, so naming the range never passes for naming the PR.
  fixBranch: 'agent-terminal/review-fixture-branch',
};
const DONE = '.agent-terminal/loop/turn-done';

const SITES: Array<{ site: string; compose: (over: { adoption?: AdoptedRunRefs; ticket?: number }) => string }> = [
  {
    site: 'the work prompt',
    compose: (over) => composeAppWorkPrompt({ recipeBody: '# work turn\nReview the change.', turnKey: 'work-review', doneRelPath: DONE, completion: null, ...over }),
  },
  {
    site: 'the review-and-fix prompt',
    compose: (over) =>
      composeReviewAndFixPrompt({
        roster: [{ loop: 'review-loop', persona: 'review-intent', charter: '/tiers/review-loop/charter/intent.md', tools: ['Read'] }],
        sections: ['summary', 'findings'],
        reportRel: '.agent-terminal/loop/reports/1.json',
        round: 1,
        turnKey: 'review-review',
        doneRelPath: DONE,
        agentKind: 'claude-code',
        ...over,
      }),
  },
  {
    site: 'the consolidator prompt',
    compose: (over) =>
      composeConsolidatePrompt({
        recipeBody: '# consolidate\nJudge the round.',
        catalog: ['review-intent'],
        reportRels: ['.agent-terminal/loop/reports/1.json'],
        outputRel: '.agent-terminal/loop/consolidator.json',
        round: 1,
        turnKey: 'consolidate-review',
        doneRelPath: DONE,
        ...over,
      }),
  },
  {
    site: 'the reviewer hand-off',
    compose: (over) => reviewerHandoffLines({ carried: [], ...over }).join('\n'),
  },
];

const wholeNumber = (n: number): RegExp => new RegExp(`(^|\\D)${n}(\\D|$)`);
/** The lines of `prompt` that tell the agent to read `ticket` through gh, naming its repository on origin's host. */
const readsTicket = (prompt: string, ticket: { repo: string; number: number }): string[] =>
  prompt.split('\n').filter((l) => /\bgh\b/.test(l) && l.includes(HOST) && l.includes(ticket.repo) && wholeNumber(ticket.number).test(l));

/** The lines a ticket run's prompts present the change with: the working-tree diff, and the branch's commits since
 *  it left the default branch. Each is what one section adds for code work over the same section without it. */
const workingTreeLines = flowDocumentLines().filter((l) => l !== '' && !flowDocumentLines('described-elsewhere').includes(l));
const withSubject = reviewerHandoffLines({ carried: [], subjectRel: '.agent-terminal/loop/artifacts/plan.md' });
const branchChangeLines = reviewerHandoffLines({ carried: [] }).filter((l) => !withSubject.includes(l));
/** The ticket run's flow-documents claim: its section without the closing standards line, which an adopting run
 *  may keep. */
const describedElsewhere = flowDocumentLines('described-elsewhere').filter((l) => l !== '');
const flowDocumentClaimLines = describedElsewhere.slice(0, -1);
const ticketRunChangeLines = [...workingTreeLines, ...branchChangeLines, ...flowDocumentClaimLines];
const linesOf = (prompt: string): string[] => prompt.split('\n');

describe.each(SITES)('$site of an adopting run (#304 AC 6, 7)', ({ compose }) => {
  it('names every ticket the PR closes, each with an instruction to read it through gh in its own repository', () => {
    const prompt = compose({ adoption: ADOPTION });
    expect.soft(readsTicket(prompt, ADOPTION.tickets[0]), 'owner/repo#176').not.toEqual([]);
    expect.soft(readsTicket(prompt, ADOPTION.tickets[1]), 'contributor/fork#177').not.toEqual([]);
  });

  it('names the reviewed pull request', () => {
    expect(compose({ adoption: ADOPTION })).toMatch(wholeNumber(ADOPTION.pr));
  });

  it('presents the change as the range from the recorded merge-base to the fix branch, and leaves out how the ticket run presents its change and flow documents', () => {
    const lines = linesOf(compose({ adoption: ADOPTION }));
    expect.soft(lines.filter((l) => l.includes(ADOPTION.baseOid) && l.includes(ADOPTION.fixBranch))).not.toEqual([]);
    expect.soft(lines.filter((l) => ticketRunChangeLines.includes(l))).toEqual([]);
  });

  it("adds a line about the tree's .agent-terminal/ content that a ticket run's prompt does not have", () => {
    const ticketRun = linesOf(compose({ ticket: 176 }));
    expect(linesOf(compose({ adoption: ADOPTION })).filter((l) => l.includes('.agent-terminal/') && !l.includes(ADOPTION.fixBranch) && !ticketRun.includes(l))).not.toEqual([]);
  });
});

describe.each(SITES.filter((s) => s.site !== 'the consolidator prompt'))('$site of a ticket run (#304 AC 26)', ({ compose }) => {
  it('still presents its change and flow documents as the ticket run did', () => {
    expect(linesOf(compose({ ticket: 176 })).filter((l) => ticketRunChangeLines.includes(l))).not.toEqual([]);
  });
});
