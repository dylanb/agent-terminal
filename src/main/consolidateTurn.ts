// §27.6/§27.7 — the pure, data-driven pieces of the §27 consolidator turn, kept out of the engine so they are
// asserted from the outside: the pre-consolidate boundary selection (data from the def, §27.7), the
// last-two-report window (a fixed window off the versioned report series, §27.6/AC2), and the consolidator
// prompt composer. The prompt is single-sourced from the SHARED consolidator-output vocabulary
// (consolidatorOutput.ts) so the shape the actor is told to write and the shape the completion predicate
// accepts derive from one definition (§93 composed-prompt-is-a-writer).

import type { LoopDefV2 } from './loopDefV2';
import { boundaryCommand } from './appWorkTurn';
import { doneSignalInstruction } from '../shared/loopTurn';
import { CLEAN_RULE_LINES, CONSOLIDATOR_FIELDS, CONSOLIDATOR_VERDICTS, exampleConsolidatorOutput } from '../shared/consolidatorOutput';
import { ticketPromptLines } from '../shared/currentTicket';
import { checkerLines } from './artifactCheck';

/** The boundary name preceding CONSOLIDATE in the §27.3 chain (`REVIEW-AND-FIX → boundary → CONSOLIDATE`).
 *  The engine runs whatever the def declares under this name, never a hardcoded choice (§27.7). */
const PRE_CONSOLIDATE_BOUNDARY = 'pre-consolidate';

/** The context boundary crossed before CONSOLIDATE (§27.3/§27.7): the def's `pre-consolidate` boundary
 *  policy, defaulting to `/clear` when the def declares none (§27.7 prefers a clear pre-consolidate). */
export function preConsolidateBoundaryCommand(def: LoopDefV2): string {
  const b = def.boundaries.find((x) => x.boundary === PRE_CONSOLIDATE_BOUNDARY);
  return b ? boundaryCommand(b) : '/clear';
}

/** The rounds whose reports the consolidator reads (§27.6/AC2): exactly this round and the previous one — a
 *  FIXED two-report window that does not grow with round depth. On the first round there is only one report.
 *  Derived from the round number off the versioned report series, never from ambient state. */
export function lastTwoReportRounds(round: number): number[] {
  return round <= 1 ? [round] : [round - 1, round];
}

export interface ConsolidatePromptReq {
  /** The def's consolidator recipe body (§27.8), already read from the confined recipe path. */
  recipeBody: string;
  /** The def's reviewer catalog personas (§27.4) — the set the chosen roster must be drawn from. */
  catalog: string[];
  /** The repo-relative paths of the last two round reports (this round + the previous, §27.6/AC2). */
  reportRels: string[];
  /** The repo-relative path the consolidator writes its verdict output to (§27.6). */
  outputRel: string;
  /** The round this consolidator judges. */
  round: number;
  /** The turn key the done-signal is scoped to (e.g. `consolidate-plan`). */
  turnKey: string;
  /** §27.12 — the command that runs the loop's own format check on the verdict; absent omits it. */
  checkCommand?: string;
  /** The repo-relative §27 done-file the consolidator writes last (after verifying its output, §27.12a). */
  doneRelPath: string;
  /** §19.1 — the GitHub issue the flow resolved (the SAME identity the gate side-effects act on), named so the
   *  consolidator judges the round against THIS ticket, never one re-derived from the branch/PR/cwd. Absent when
   *  the flow resolved no ticket. */
  ticket?: number;
}

/** The verdict format rules (§27.6), from the shared consolidator-output vocabulary. */
function verdictFormatLines(catalog: string[]): string[] {
  const f = CONSOLIDATOR_FIELDS;
  return [
    `- \`"${f.verdict}"\`: EXACTLY one of ${CONSOLIDATOR_VERDICTS.map((v) => `\`"${v}"\``).join(' / ')}, spelled verbatim.`,
    `- ONLY when the verdict is \`"another round"\`: \`"${f.roster}"\`, a non-empty list of personas drawn from the`,
    `  reviewer catalog below (a persona the catalog does not declare can never be invoked): ${catalog.join(', ')}`,
    `- ONLY when the verdict is \`"stop for a human"\`: \`"${f.reason}"\`, text saying why a human must decide.`,
  ];
}

export interface VerdictRepairPromptReq {
  outputRel: string;
  /** What the loop's format check found wrong with the verdict on disk. */
  problems: string[];
  catalog: string[];
  round: number;
  turnKey: string;
  doneRelPath: string;
  checkCommand?: string;
}

/** §27.12 — the retry for a consolidator turn whose verdict is on disk but malformed: repair its format alone,
 *  naming each problem, keeping the judgment already made. */
export function composeVerdictRepairPrompt(req: VerdictRepairPromptReq): string {
  const lines: string[] = [
    `This is a REPAIR of the round-${req.round} consolidator verdict, not a new judgment.`,
    '',
    `The verdict ${req.outputRel} is on disk but fails the loop's format check, so the turn is not finished.`,
    'Fix ONLY that file, keeping the judgment you already made; change only what the problems below name.',
    '',
    'Problems:',
    ...req.problems.map((p) => `- ${p}`),
    '',
    'The verdict is a JSON object with:',
    ...verdictFormatLines(req.catalog),
  ];
  if (req.checkCommand !== undefined) lines.push(...checkerLines(req.checkCommand, 'verdict'));
  lines.push(
    '',
    doneSignalInstruction(req.turnKey, req.outputRel, req.doneRelPath),
    '',
    'A well-formed example:',
    '',
    exampleConsolidatorOutput('another round', req.catalog).trimEnd(),
  );
  return `${lines.join('\n')}\n`;
}

/** Compose the §27 consolidator prompt (§27.6): read EXACTLY the last two round reports and nothing else,
 *  judge the round, emit a verdict from the closed set — and, only for `another round`, a next roster chosen
 *  from the def's catalog — writing that output in the shared vocabulary the completion predicate reads, so
 *  the prompt and the predicate cannot diverge. A single canonical example anchors the shape. Ends with the
 *  shared done-signal instruction, verifying the output on disk before the done-file (§27.12a). */
export function composeConsolidatePrompt(req: ConsolidatePromptReq): string {
  const lines: string[] = [];
  lines.push(req.recipeBody.trimEnd());
  // §19.1 — bind the consolidator to the engine-resolved ticket it judges the round against (one shared source).
  if (req.ticket !== undefined) lines.push(...ticketPromptLines(req.ticket));
  lines.push(
    '',
    `This is the consolidator turn for round ${req.round}.`,
    '',
    'Read EXACTLY these round reports — this round and the previous one — and nothing else:',
  );
  for (const rel of req.reportRels) lines.push(`- ${rel}`);
  lines.push(
    '',
    'Judge the round and choose the next step. Then write your verdict to',
    `${req.outputRel} as a JSON object with:`,
    ...verdictFormatLines(req.catalog),
    '',
    ...CLEAN_RULE_LINES,
    'A terminal verdict (`clean` / `stop for a human`) needs no roster.',
  );
  if (req.checkCommand !== undefined) lines.push(...checkerLines(req.checkCommand, 'verdict'));
  lines.push(
    '',
    doneSignalInstruction(req.turnKey, req.outputRel, req.doneRelPath),
    '',
    'A well-formed example:',
    '',
    exampleConsolidatorOutput('another round', req.catalog).trimEnd(),
  );
  return `${lines.join('\n')}\n`;
}
