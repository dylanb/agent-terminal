// §27.3/§27.4/§27.5 — the pure, data-driven pieces of the §27 review-and-fix turn, kept out of the engine so
// they are asserted from the outside: the pre-review boundary selection (data from the def, §27.7), the
// round's roster (the def's full reviewer catalog, §27.4), and the review-and-fix prompt composer. The prompt
// is single-sourced from the SHARED report vocabulary (roundReport.ts) so the shape the fixer is told to
// write and the shape the completion predicate accepts derive from one definition (CLAUDE.md shared-semantics).

import type { LoopDefV2, ReviewerTools } from './loopDefV2';
import { boundaryCommand, flowDocumentLines, designCheckLines, sliceBriefLines } from './appWorkTurn';
import type { ChainedInput } from './chainedInput';
import type { SliceBriefDelivery } from './sliceBriefReader';
import { validFeedback } from './appLoopState';
import { doneSignalInstruction } from '../shared/loopTurn';
import { DISPOSITIONS, FIXED_DISPOSITION, INVALID_DISPOSITION, NEEDS_HUMAN_DISPOSITION, OUT_OF_SCOPE_DISPOSITION, FAILED_STATUS, NOT_LOADED_STATUS, RAN_STATUS, REPORT_FIELDS, exampleRoundReport } from '../shared/roundReport';
import { PHASE_RESULT_FIELDS, composePhaseResultInstruction } from '../shared/phaseResult';
import { checkerLines } from './artifactCheck';
import { REFACTOR_COMPLETING_OUTCOME } from '../shared/phaseOutcome';
import { RED_CHECK_MISSING_WARNING, composeRedCheckInstruction, redCheckReportRel } from '../shared/redCheck';
import { adoptedRunLines, ticketPromptLines, type AdoptedRunRefs } from '../shared/currentTicket';
import { codexReviewerAgentName, reviewerAgentName } from './reviewerAgents';
import type { AgentKind } from './agentKind';
import { PRE_REVIEW_BOUNDARY, type PolishPolicy } from '../shared/engineCapabilities/loop';

/** The context boundary crossed before REVIEW-AND-FIX (§27.3/§27.7): the def's `pre-review` boundary policy,
 *  defaulting to `/clear` when the def declares none (every boundary is clear-or-compact). */
export function preReviewBoundaryCommand(def: LoopDefV2): string {
  const b = def.boundaries.find((x) => x.boundary === PRE_REVIEW_BOUNDARY);
  return b ? boundaryCommand(b) : '/clear';
}

/** A reviewer persona and the confined path of its charter (§27.4). The one shape the roster source, the
 *  prompt request, and the engine's in-flight review turn all share, so the three cannot drift. */
export interface RosterEntry {
  loop: string;
  persona: string;
  charter: string;
  tools: ReviewerTools;
}

/** Round 1's roster (§27.4/AC2): the ONE production derivation of the round roster from the def. Later rounds'
 *  subset selection is the consolidator's job (N4). */
export function reviewRoster(def: LoopDefV2): RosterEntry[] {
  return def.reviewers.map((r) => ({ loop: def.name, persona: r.persona, charter: r.charter, tools: r.tools }));
}

/** §27.4 */
export function reviewerAgentFor(kind: AgentKind, r: Pick<RosterEntry, 'loop' | 'persona'>): string {
  return kind === 'codex' ? codexReviewerAgentName(r.loop, r.persona) : reviewerAgentName(r.loop, r.persona);
}

/** The def's reviewer catalog as persona names (§27.4): the ONE projection the panel display, the
 *  consolidator's roster-validation catalog, and the round roster derive from, so they cannot drift on which
 *  personas the def declares (CLAUDE.md shared-semantics). */
export function catalogPersonas(def: LoopDefV2): string[] {
  return def.reviewers.map((r) => r.persona);
}

export const REVIEWER_HANDOFF_BEGIN = '----- reviewer hand-off begins -----';
export const REVIEWER_HANDOFF_END = '----- reviewer hand-off ends -----';

export interface ReviewAndFixPromptReq {
  /** The round's roster — charters handed by reference, not inlined content (§27.4). */
  roster: RosterEntry[];
  /** The def's prescribed report structure (§27.5). */
  sections: string[];
  /** §27.8 — the def's polish policy; absent is `fix`. */
  polish?: PolishPolicy;
  /** The repo-relative round-keyed report path the fixer writes (§27.5). */
  reportRel: string;
  /** The round number. */
  round: number;
  /** The turn key the done-signal is scoped to (e.g. `review-plan`). */
  turnKey: string;
  /** §27.12 — the command that runs the loop's own format check on this round's report; absent omits it. */
  checkCommand?: string;
  /** The repo-relative §27 done-file the fixer writes last (after its subagents return, §27.12a). */
  doneRelPath: string;
  /** §27.9/§19.4 (AC4) — the operator's request-changes feedback for THIS round, delivered alongside the
   *  reviewers' findings (never to the consolidator or the work turn). Absent on a consolidator-driven
   *  another-round; a blank/whitespace-only value is treated as none, so no empty block is ever emitted. */
  feedback?: string;
  /** §28.5.3 — a REFACTOR loop's round-keyed phase-result path: present ⟺ this is a refactor round, which
   *  additionally runs the targeted tests and writes the result the round gate reads (softer than GREEN —
   *  {passed}, no build). Absent for RED/GREEN loops' review rounds (no phase-result block emitted). */
  resultRel?: string;
  /** §27.12 — the command that runs the loop's own check on the phase result a refactor or RED round edits; absent
   *  omits it. */
  resultCheckCommand?: string;
  /** §28.5.3 */
  redCheck?: { command: string | null; resultRel: string };
  /** §19.1 — the GitHub issue the flow resolved (the SAME identity the gate side-effects act on), named so the
   *  turn hands each reviewer THIS ticket, never one re-derived from the branch/PR/cwd. Absent when the flow
   *  resolved no ticket. */
  ticket?: number;
  /** An adopting run's intent and change, presented in place of a ticket run's ticket and flow documents. */
  adoption?: AdoptedRunRefs;
  /** §27.4 — the repo-relative work artifact this round reviews; absent for a loop whose product is commits
   *  or a phase-result file (the reviewers then pull the diff themselves). */
  subjectRel?: string;
  /** §27.10/§27.4 */
  inputs?: ChainedInput[];
  /** §28.4.2 — the operator's back-to-RED brief for the slice this TDD phase round belongs to. */
  sliceBrief?: SliceBriefDelivery;
  /** §27.3 */
  loopBrief?: string;
  /** §28.4 */
  slice?: number;
  /** §27.4 */
  agentKind: AgentKind;
}

/** The round-report format rules (§27.5), from the ONE shared descriptor the completion predicate reads.
 *  `whichReviewers` names the roster the reviewer records must cover. */
function reportFormatLines(sections: string[], whichReviewers: string, kind: AgentKind): string[] {
  const f = REPORT_FIELDS;
  return [
    `- \`"${f.sections}"\`: an object with a text value for each of these sections: ${sections.join(', ')}`,
    `- \`"${f.reviewers}"\`: a list with one record for ${whichReviewers} — including any that failed to run or`,
    `  found nothing. Dropping a reviewer makes the report malformed. Each record has \`"${f.persona}"\`, \`"${f.status}"\` and`,
    `  \`"${f.issues}"\`. The status is \`"${RAN_STATUS}"\` for a reviewer that ran (its issues list may be empty), \`"${FAILED_STATUS}"\` for one`,
    '  that FAILED to run (crashed, timed out, produced nothing usable) — a round with a failed reviewer can never be',
    `  judged clean (§27.5/§27.6) — and \`"${NOT_LOADED_STATUS}"\` for one whose`,
    kind === 'codex' ? '  Codex agent cannot be found: this agent session started' : '  subagent_type the Task tool cannot find: this agent session started',
    '  before it was installed, so record it and spawn nothing in its place.',
    `- each issue: \`"${f.issue}"\`, \`"${f.disposition}"\`, \`"${f.reason}"\`, and (when fixed) \`"${f.whatChanged}"\`, each as text.`,
    `- each \`"${f.disposition}"\` is EXACTLY one of: ${DISPOSITIONS.map((d) => `\`"${d}"\``).join(' / ')} — spelled`,
    '  verbatim, no other value.',
  ];
}

export interface ReportRepairPromptReq {
  reportRel: string;
  /** What the loop's format check found wrong with the report on disk. */
  problems: string[];
  sections: string[];
  roster: string[];
  round: number;
  turnKey: string;
  doneRelPath: string;
  checkCommand?: string;
  /** §27.4 */
  agentKind: AgentKind;
}

/** §27.12 — the retry for a round whose report is on disk but malformed: repair the report alone, naming each
 *  problem, so a formatting slip never re-runs the reviewers or re-touches the code. */
export function composeReportRepairPrompt(req: ReportRepairPromptReq): string {
  const lines: string[] = [
    `This is a REPAIR of the round-${req.round} report, not a new review round.`,
    '',
    `The round report ${req.reportRel} is on disk but fails the loop's format check, so the round is not`,
    'finished. Fix ONLY that file. Do not re-run the reviewers, and do not change code, tests, or any other',
    'file. Keep every finding and disposition already recorded; change only what the problems below name.',
    '',
    'Problems:',
    ...req.problems.map((p) => `- ${p}`),
    '',
    'The report is a JSON object with:',
    ...reportFormatLines(req.sections, `EVERY reviewer of this round (${req.roster.join(', ')})`, req.agentKind),
  ];
  if (req.checkCommand !== undefined) lines.push(...checkerLines(req.checkCommand, 'report'));
  lines.push(
    '',
    doneSignalInstruction(req.turnKey, req.reportRel, req.doneRelPath),
    '',
    'A well-formed example:',
    '',
    exampleRoundReport({ sections: req.sections, roster: req.roster }).trimEnd(),
  );
  return `${lines.join('\n')}\n`;
}

export type ReviewerHandoffReq = Pick<ReviewAndFixPromptReq, 'ticket' | 'adoption' | 'subjectRel' | 'slice'> & { carried: ChainedInput[] };

/** §27.4 */
export function reviewerHandoffLines(req: ReviewerHandoffReq): string[] {
  const lines: string[] = [];
  if (req.adoption !== undefined) lines.push(...adoptedRunLines(req.adoption).slice(1));
  else {
    lines.push(
      req.ticket !== undefined
        ? `Review the work for GitHub issue #${req.ticket}. Read the issue and its comments with \`gh issue view ${req.ticket} --comments\`.`
        : "Review this loop's work.",
    );
  }
  if (req.subjectRel !== undefined) {
    lines.push(
      `Grade ${req.subjectRel}, the artifact this loop produced, not the issue body on GitHub. The issue is the`,
      'intent the artifact must honour, and it can still hold text the artifact has since fixed.',
    );
  } else if (req.adoption === undefined) {
    lines.push(
      "The code and tests under review are this branch's change: its commits since it left the repository's",
      'default branch, plus any uncommitted changes. See them with git: `git log`, `git status`, and `git diff HEAD`.',
    );
  }
  if (req.slice !== undefined) {
    lines.push(`This round covers impl-slice ${req.slice} of the plan only; work that belongs to another slice is not under review.`);
  }
  if (req.carried.length > 0) {
    lines.push('Grade it against these documents, beside the ticket:', ...req.carried.map((i) => `  - ${i.id}: ${i.rel}`));
  }
  lines.push(
    ...(req.adoption === undefined ? flowDocumentLines('described-elsewhere').slice(1) : []),
    'Do not run the full test suite or the end-to-end harness: read the test results the work recorded, and run only',
    'the targeted tests that checking a specific finding needs.',
    'Do not change any file: report your findings, and the fixer makes every change.',
    'Return each finding with its file:line, the issue, its concrete consequence, and the fix. Do not rate severity.',
    'If you find nothing, return exactly: no findings',
  );
  return lines;
}

/** §27.6 */
export function fixCriterionLines(): string[] {
  return [
    '',
    // §27.6 — the materiality floor that lets "clean = a round that changed nothing" reach a fixed point on
    // prose: an in-scope finding that changes no observable outcome must be DISMISSED, not fixed, or each
    // rewrite of already-correct text manufactures the next round's findings and the loop never converges.
    'Fix an issue only when acting on it changes an OBSERVABLE OUTCOME — correctness, safety, a contract two',
    'surfaces actually read, or whether the next reader/implementer can follow the artifact. An in-scope finding',
    'that leaves every observable outcome unchanged — an equal-quality rewording, a citation already correct',
    'where a more-precise one would not change the meaning, a defensible authoring choice the ticket does not',
    'require — is `dismissed — invalid` (it is not a defect), NEVER `fixed`. Do not rewrite an already-correct',
    'artifact for such a refinement: that only manufactures the next round\'s findings and keeps the loop from',
    'ever producing a no-change round. Dismiss what is out of scope or invalid; escalate to `needs a human`',
    'only what the loop is not entitled to decide.',
    '',
    'Test-support code — a fake, stand-in, or double of a real tool, and the fixtures and helpers around it —',
    'exists to serve the tests that use it. A finding that it differs from the real tool, or that a branch of it',
    'has no test of its own, changes an observable outcome only when a test the ticket needs relies on that',
    'behaviour, so the gap would let that test pass over broken code or fail over correct code. Otherwise it is',
    '`dismissed — invalid`, never `fixed`: a double can always be made more faithful, so fixing such gaps never',
    'runs out. A test written later that relies on the behaviour is reviewed in its own round.',
  ];
}

/** §27.4 */
export function reviewerSpawnLines(handoff: ReviewerHandoffReq, fixedHow: string, kind: AgentKind): string[] {
  const spawn =
    kind === 'codex'
      ? [
          'Spawn each reviewer below in parallel as its installed Codex agent, by exactly the name given, and give each',
          'the reviewer hand-off below word for word, adding nothing: no diff, no prior review, no findings.',
          'Its charter is its own instructions, so never hand it one, and never spawn a default or general agent in',
          'its place.',
        ]
      : [
          'Spawn each reviewer below as a PARALLEL Task subagent with exactly that subagent_type, and give each the',
          'reviewer hand-off below word for word, adding nothing: no diff, no prior review, no findings.',
          'Its charter is its own instructions, so never hand it one, and never substitute a general-purpose agent or any',
          'other type for it.',
        ];
  return [
    ...spawn,
    `Receive their findings into your own context, then fix or dismiss each ${fixedHow}.`,
    '',
    REVIEWER_HANDOFF_BEGIN,
    ...reviewerHandoffLines(handoff),
    REVIEWER_HANDOFF_END,
  ];
}

/** §27.4 */
export function rosterLines(roster: RosterEntry[], kind: AgentKind): string[] {
  return kind === 'codex'
    ? ['', 'Reviewers (persona — Codex agent):', ...roster.map((r) => `- ${r.persona} — agent: ${reviewerAgentFor(kind, r)}`)]
    : ['', 'Reviewers (persona — subagent_type):', ...roster.map((r) => `- ${r.persona} — subagent_type: ${reviewerAgentFor(kind, r)}`)];
}

/** §27.8 */
function polishDeferLines(): string[] {
  return [
    '',
    'This loop DEFERS POLISH to a later loop in its flow, which re-reviews this work with a catalog that fixes',
    'polish. A polish finding — one whose fix changes no runtime behavior, no test\'s ability to fail, and no',
    'contract another surface reads: a rename, comment wording or trimming, de-duplicating logic that already',
    `behaves identically, style or convention conformance — is \`${OUT_OF_SCOPE_DISPOSITION}\` with the reason`,
    '`polish — deferred to a later loop`, NEVER `fixed` in this loop. A round whose only',
    'findings are polish therefore changes nothing.',
  ];
}

/** §27.3 */
export const GOAL_NO_CHANGE_CLAUSE =
  "no review pass is left to run, because the latest pass's fixes, or the work itself when no pass ran, changed nothing but this step's report and its recorded test evidence (an edit to the plan, the ticket, code or tests is a change)";

/** §27.3 */
function goalPassLines(): string[] {
  return [
    '',
    'PASSES — run a review pass only over a change.',
    "- When your work changed nothing but this step's report and its recorded test evidence, run no review at all.",
    "- After a pass, when its fixes changed nothing but this step's report and its recorded test evidence — every",
    '  finding was dismissed, or the only edit was to the report or its test evidence — the review is done: do not',
    '  spawn the reviewers again. An edit to the plan, the ticket, code or tests is a change.',
    '- Otherwise run another pass. The first pass runs every reviewer. A later pass runs only the reviewers whose',
    '  findings you fixed and any whose area your fixes touched; it runs every reviewer again only when a fix changes',
    '  the acceptance criteria, the scope, the approach or the slices the work answers to.',
    '- In any pass, skip a reviewer whose lens the change cannot touch, such as accessibility when no user-interface',
    '  file changed, and log each skip, with its reason, in the review history. That is the only reason the first',
    '  pass may leave a reviewer out.',
    `The review ends when ${GOAL_NO_CHANGE_CLAUSE}.`,
  ];
}

/** §27.3/§27.4/§27.8 */
export function composeGoalReviewLines(roster: RosterEntry[], handoff: ReviewerHandoffReq, polish: PolishPolicy | undefined, kind: AgentKind): string[] {
  return [
    '',
    'REVIEWS — this turn reviews its own work with the reviewers below, by the pass rules below.',
    ...reviewerSpawnLines(handoff, 'per the criterion below', kind),
    ...goalPassLines(),
    ...fixCriterionLines(),
    '',
    'A finding that only disagrees with a decision you made and logged, inside your decision boundary, is',
    `\`${INVALID_DISPOSITION}\`: a reviewer choosing differently is not a defect. Fix it only when the decision breaks the`,
    'ticket, the plan, or a standard the repository writes down.',
    ...(polish === 'defer' ? polishDeferLines() : []),
    ...rosterLines(roster, kind),
  ];
}

/** §27.3/§27.4/§27.5/§27.12a */
export function composeReviewAndFixPrompt(req: ReviewAndFixPromptReq): string {
  const lines: string[] = [];
  const carried = (req.inputs ?? []).filter((i) => i.rel !== req.subjectRel);
  lines.push(
    `This is the review-and-fix turn for round ${req.round}.`,
    '',
    ...reviewerSpawnLines({ ...req, carried }, 'per the criterion below', req.agentKind),
  );
  if (req.loopBrief !== undefined) {
    lines.push(
      '',
      "STANDING INSTRUCTIONS — this loop's brief, which the work turn followed. Every fix you make must meet it.",
      'A step in it that only the work turn takes, such as interviewing the operator, does not run again here: a',
      `fix that needs the operator's decision is \`${NEEDS_HUMAN_DISPOSITION}\`.`,
      '',
      req.loopBrief.trimEnd(),
    );
  }
  // §19.1 — bind the turn to the engine-resolved ticket it hands each reviewer (one shared source).
  if (req.adoption !== undefined) lines.push(...adoptedRunLines(req.adoption));
  else if (req.ticket !== undefined) lines.push(...ticketPromptLines(req.ticket));
  if (req.subjectRel !== undefined) {
    lines.push(
      '',
      `SUBJECT — ${req.subjectRel} is the artifact this loop's work turn produced and the reviewers grade. Make every`,
      'fix in that file, not in the issue body on GitHub.',
      '',
      'When a finding is that a mechanism this document specifies is wrong — an internal helper, how a command\'s',
      'arguments are parsed, a path or platform quirk — fix it by replacing that mechanism with the contract it',
      'must meet and the test that proves it, never by specifying the mechanism in more detail: each added detail',
      'is new surface the next round reviews. A fix that would add a defence against an adversary the ticket does',
      'not name, or a new state, outcome, or field that no acceptance criterion names, is',
      `\`${NEEDS_HUMAN_DISPOSITION}\`, never \`${FIXED_DISPOSITION}\`.`,
      'A finding about behaviour that no test environment in the repository exercises — the host OS when the tests',
      'run elsewhere, a real external tool the tests replace with a stand-in — is fixed by recording it, with the',
      'real-run check that verifies it, under the document\'s `Assumptions` heading, never by elaborating a',
      'workaround. When the document already lists several countermeasures for one guard and a finding is another',
      'hole in the same guard, the mechanism cannot deliver its criterion: that is',
      `\`${NEEDS_HUMAN_DISPOSITION}\` (a different mechanism or a narrower criterion), never another patch.`,
    );
  }
  if (req.adoption === undefined) lines.push(...flowDocumentLines());
  lines.push(...fixCriterionLines(), ...designCheckLines());
  if (req.polish === 'defer') lines.push(...polishDeferLines());
  lines.push(...rosterLines(req.roster, req.agentKind));
  if (req.sliceBrief !== undefined) lines.push(...sliceBriefLines(req.sliceBrief, 'fixer'));
  // This block is the OUTER framing every request-changes feedback carries ("weigh this / record how you
  // addressed it"). The compose-with-agent mode adds its own inner "Synthesize…" prefix upstream in the
  // renderer's frameFeedback; edit either aware of the other so the two divide labor rather than drift.
  const feedback = validFeedback(req.feedback);
  if (feedback !== undefined) {
    lines.push(
      '',
      'The operator requested changes at the gate. Weigh this feedback as a first-class input to THIS round,',
      "alongside the reviewers' findings — record how you addressed it in the round report:",
      '',
      feedback,
    );
  }
  lines.push('', `Then write the round report to ${req.reportRel}, a JSON object with:`, ...reportFormatLines(req.sections, 'EVERY reviewer above', req.agentKind));
  // §28.5.3 — a refactor round writes a phase-result file the round gate reads (softer than GREEN: {passed},
  // no build), via the shared writer so this instruction stays single-sourced with the parse predicate. The
  // done-signal verifies the RESULT, not the report — it is the artifact the fixer is least habituated to (the
  // report stays gated by completionSatisfied).
  if (req.resultRel !== undefined) {
    lines.push(
      '',
      ...composePhaseResultInstruction({
        resultRel: req.resultRel,
        completingOutcome: REFACTOR_COMPLETING_OUTCOME,
        closing: [
          `This round is done only when the tests still pass (\`"${PHASE_RESULT_FIELDS.outcome}": "${REFACTOR_COMPLETING_OUTCOME}"\`).`,
          'A failing or errored test does NOT complete it — fix so the tests pass, then re-run and re-classify.',
          '(A legitimate fixture change is recorded and flagged for regression-guard and the human, not blocked.)',
          ...(req.resultCheckCommand !== undefined ? checkerLines(req.resultCheckCommand, 'phase result') : []),
        ],
      }),
    );
  }
  if (req.redCheck !== undefined) {
    const { command, resultRel } = req.redCheck;
    lines.push(
      '',
      ...(command !== null
        ? [
            ...composeRedCheckInstruction({ command, reportRel: redCheckReportRel(resultRel), resultRel }),
            ...(req.resultCheckCommand !== undefined ? checkerLines(req.resultCheckCommand, 'phase result') : []),
          ]
        : ['Put this warning line, verbatim, in the round report\'s summary:', '', RED_CHECK_MISSING_WARNING]),
    );
  }
  if (req.checkCommand !== undefined) lines.push(...checkerLines(req.checkCommand, 'report'));
  lines.push(
    '',
    doneSignalInstruction(req.turnKey, req.resultRel ? `${req.reportRel} and ${req.resultRel}` : req.reportRel, req.doneRelPath),
    '',
    'A well-formed example:',
    '',
    exampleRoundReport({ sections: req.sections, roster: req.roster.map((r) => r.persona) }).trimEnd(),
  );
  return `${lines.join('\n')}\n`;
}
