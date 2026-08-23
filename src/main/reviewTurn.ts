// §27.3/§27.4/§27.5 — the pure, data-driven pieces of the §27 review-and-fix turn, kept out of the engine so
// they are asserted from the outside: the pre-review boundary selection (data from the def, §27.7), the
// round's roster (the def's full reviewer catalog, §27.4), and the review-and-fix prompt composer. The prompt
// is single-sourced from the SHARED report vocabulary (roundReport.ts) so the shape the fixer is told to
// write and the shape the completion predicate accepts derive from one definition (CLAUDE.md shared-semantics).

import type { LoopDefV2 } from './loopDefV2';
import { boundaryCommand } from './appWorkTurn';
import { validFeedback } from './appLoopState';
import { doneSignalInstruction } from '../shared/loopTurn';
import { DISPOSITIONS, REPORT_GRAMMAR, exampleRoundReport } from '../shared/roundReport';
import { PHASE_RESULT_GRAMMAR, composePhaseResultInstruction } from '../shared/phaseResult';
import { REFACTOR_COMPLETING_OUTCOME } from '../shared/phaseOutcome';

/** The boundary name preceding REVIEW-AND-FIX in the §27.3 chain (`WORK → boundary → REVIEW-AND-FIX`). The
 *  engine runs whatever the def declares under this name, never a hardcoded clear-or-compact choice (§27.7). */
const PRE_REVIEW_BOUNDARY = 'pre-review';

/** The context boundary crossed before REVIEW-AND-FIX (§27.3/§27.7): the def's `pre-review` boundary policy,
 *  defaulting to `/clear` when the def declares none (every boundary is clear-or-compact). */
export function preReviewBoundaryCommand(def: LoopDefV2): string {
  const b = def.boundaries.find((x) => x.boundary === PRE_REVIEW_BOUNDARY);
  return b ? boundaryCommand(b) : '/clear';
}

/** A reviewer persona and the confined path of its charter (§27.4). The one shape the roster source, the
 *  prompt request, and the engine's in-flight review turn all share, so the three cannot drift. */
export interface RosterEntry {
  persona: string;
  charter: string;
}

/** Round 1's roster (§27.4/AC2): the ONE production derivation of the round roster from the def. Later rounds'
 *  subset selection is the consolidator's job (N4). */
export function reviewRoster(def: LoopDefV2): RosterEntry[] {
  return def.reviewers.map((r) => ({ persona: r.persona, charter: r.charter }));
}

/** The def's reviewer catalog as persona names (§27.4): the ONE projection the panel display, the
 *  consolidator's roster-validation catalog, and the round roster derive from, so they cannot drift on which
 *  personas the def declares (CLAUDE.md shared-semantics). */
export function catalogPersonas(def: LoopDefV2): string[] {
  return def.reviewers.map((r) => r.persona);
}

export interface ReviewAndFixPromptReq {
  /** The round's roster — charters handed by reference, not inlined content (§27.4). */
  roster: RosterEntry[];
  /** The def's prescribed report structure (§27.5). */
  sections: string[];
  /** The repo-relative round-keyed report path the fixer writes (§27.5). */
  reportRel: string;
  /** The round number. */
  round: number;
  /** The turn key the done-signal is scoped to (e.g. `review-plan`). */
  turnKey: string;
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
}

/** Compose the §27 review-and-fix prompt (§27.3/§27.4/§27.5): spawn the roster as parallel subagents each
 *  handed only the ticket and its charter, fix valid in-scope issues and dismiss the rest, and write the
 *  round report in the prescribed structure — the disposition set, the per-issue element labels, and the
 *  empty marker all taken from the ONE shared descriptor the completion predicate reads, so the prompt and
 *  the predicate cannot diverge. A single canonical example anchors the shape. Ends with the shared
 *  done-signal instruction, verifying the report on disk before the done-file (§27.12a). */
export function composeReviewAndFixPrompt(req: ReviewAndFixPromptReq): string {
  const g = REPORT_GRAMMAR;
  const lines: string[] = [];
  lines.push(
    `This is the review-and-fix turn for round ${req.round}.`,
    '',
    'Spawn each reviewer below as a PARALLEL Task subagent, handing each ONLY the ticket and its charter —',
    'no diff, no plan, no prior review. Each pulls what it needs with tools. Receive their findings into your',
    'own context, fix every valid in-scope issue yourself, and dismiss what is out of scope or invalid.',
    '',
    'Reviewers (persona — charter):',
  );
  for (const r of req.roster) lines.push(`- ${r.persona} — ${r.charter}`);
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
  lines.push(
    '',
    `Then write the round report to ${req.reportRel}, a Markdown document with this structure:`,
    `- one \`${g.sectionPrefix.trim()} <section>\` heading for each of these sections: ${req.sections.join(', ')}`,
    `- one \`${g.personaPrefix.trim()} <persona>\` record for EVERY reviewer above — including any that failed to`,
    '  run or found nothing. Dropping a reviewer makes the report malformed. In a reviewer\'s record:',
    `  a reviewer that RAN and raised no issues carries the line \`${g.emptyMarker}\`; a reviewer that FAILED to`,
    `  run (crashed, timed out, produced nothing usable) carries the line \`${g.failedMarker}\` instead — the two`,
    '  are distinct, and a round with a failed reviewer can never be judged clean (§27.5/§27.6).',
    `- for every issue you record under a reviewer, the labelled lines \`${g.issueLabel}:\`, \`${g.dispositionLabel}:\`,`,
    `  \`${g.reasonLabel}:\`, and (when fixed) \`${g.whatChangedLabel}:\`.`,
    `- each \`${g.dispositionLabel}:\` is EXACTLY one of: ${DISPOSITIONS.map((d) => `\`${d}\``).join(' / ')} — spelled`,
    '  verbatim, no other value.',
  );
  // §28.5.3 — a refactor round ALSO runs the targeted tests and writes a phase-result file the round gate reads
  // (softer than GREEN: {passed}, no build). The shared writer keeps this instruction single-sourced with the
  // parse predicate; the round then verifies the RESULT on disk before the done-file (the new artifact the
  // fixer is least habituated to). Absent `resultRel` (RED/GREEN loops' review rounds), no block is emitted.
  if (req.resultRel !== undefined) {
    lines.push(
      '',
      ...composePhaseResultInstruction({
        resultRel: req.resultRel,
        completingOutcome: REFACTOR_COMPLETING_OUTCOME,
        closing: [
          `This round is done only when the tests still pass (\`${PHASE_RESULT_GRAMMAR.outcomeLabel}: ${REFACTOR_COMPLETING_OUTCOME}\`).`,
          'A failing or errored test does NOT complete it — fix so the tests pass, then re-run and re-classify.',
          '(A legitimate fixture change is recorded and flagged for regression-guard and the human, not blocked.)',
        ],
      }),
    );
  }
  lines.push(
    '',
    doneSignalInstruction(req.turnKey, req.resultRel ?? req.reportRel, req.doneRelPath),
    '',
    'A well-formed example:',
    '',
    exampleRoundReport({ sections: req.sections, roster: req.roster.map((r) => r.persona) }).trimEnd(),
  );
  return `${lines.join('\n')}\n`;
}
