// §27.3/§27.7/§27.8/§27.12 — the pure, data-driven pieces of the §27 work turn, kept out of the engine so
// they are asserted from the outside: the boundary-policy→command mapping (boundaries are data, §27.7); the
// completion-artifact resolver (read from the def's declared artifact, never a hard-coded loop name); the
// completion marker the work prompt instructs and the completion check reads (ONE definition, so the
// writer↔reader cannot desync — CLAUDE.md shared-semantics); and the work-prompt composer.

import type { SliceBrief } from './appLoopState';
import { doneSignalInstruction } from '../shared/loopTurn';
import type { BoundaryPolicy, LoopDefV2 } from './loopDefV2';
import type { ChainedInput } from './chainedInput';
import { PHASE_RESULT_FIELDS, composePhaseResultInstruction, examplePhaseResult } from '../shared/phaseResult';
import { composeRedCheckInstruction, redCheckReportRel } from '../shared/redCheck';
import { ticketPromptLines } from '../shared/currentTicket';
import { RED_COMPLETING_OUTCOME, RED_VERIFICATION_OUTCOME, GREEN_COMPLETING_OUTCOME, REFACTOR_COMPLETING_OUTCOME } from '../shared/phaseOutcome';
import { GREEN_COMPLETING_BUILD_OUTCOME } from '../shared/buildOutcome';
import { APP_LOOP_DIR_SEGMENTS, ARTIFACTS_SUBDIR } from './appLoopPaths';
import { GOAL_PROGRESS_FIELDS, exampleGoalNotes, exampleGoalProgress } from '../shared/goalProgress';
import { ARTIFACT_CHECK_PASSED, checkerLines } from './artifactCheck';

/** The instance command a boundary policy issues (§27.7). `clear` resets context; `compact` carries the
 *  def's message naming what must survive it. The graded observable is the command issued + the idle
 *  confirm (§27.12b), not the agent-internal effect of compaction. */
export function boundaryCommand(policy: BoundaryPolicy): string {
  // policy.message is repo-authored (loopDefV2 applies requireString only) and this command is submitted as
  // one line, so collapse every CR/LF before interpolating — a newline would otherwise inject a second
  // command line into the agent's instruction channel (CWE-74).
  return policy.mode === 'compact' ? `/compact ${(policy.message ?? '').replace(/[\r\n]+/g, ' ')}` : '/clear';
}

/** The completion artifact the work turn must produce, resolved from the def (§27.12): the confined output
 *  binding whose id matches `work.artifact`. Null when no output backs that id — a commit-producing loop
 *  whose product is commits, which advances on the done-signal alone. Data-driven: never a loop-name check. */
export function completionArtifact(def: LoopDefV2): { path: string; rel: string } | null {
  const binding = def.outputs.find((o) => o.id === def.work.artifact);
  return binding ? { path: binding.path, rel: binding.rel } : null;
}

/** Insert `.slice-N` before the final extension of a path's last segment: `.../red-result.json` →
 *  `.../red-result.slice-2.json`. Only the basename is rewritten (the directory is untouched), and `slice` is a
 *  positive integer, so nothing traversal-shaped can reach the string — the already-confined location stays in
 *  its artifacts subtree. */
function insertSliceSuffix(p: string, slice: number): string {
  const cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  const dir = cut >= 0 ? p.slice(0, cut + 1) : '';
  const base = cut >= 0 ? p.slice(cut + 1) : p;
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  return `${dir}${stem}.slice-${slice}${ext}`;
}

/** §28.4 D1 — the per-slice result-artifact location. Slice 1 keeps the def's declared name so a single-slice
 *  loop is byte-identical to before; a slice N>1 (a loop-back re-entry) gets its OWN `.slice-N` file, so a
 *  re-entered RED writes a fresh product instead of reading the prior slice's back — which would satisfy the
 *  sync completion clause vacuously. A non-integer/≤1 slice is the identity (fail toward the unsliced name). */
export function sliceArtifact(artifact: { path: string; rel: string }, slice: number): { path: string; rel: string } {
  if (!Number.isInteger(slice) || slice <= 1) return artifact;
  return { path: insertSliceSuffix(artifact.path, slice), rel: insertSliceSuffix(artifact.rel, slice) };
}

/** The one-line completion marker the work prompt instructs the agent to write into its artifact and the
 *  completion check reads back (§27.12) — present-and-marker, never a quality judgment. Anchored on the
 *  step, so it is stable across retries of the same turn and distinct between steps. */
export function completionMarker(stepId: string): string {
  return `<!-- agent-terminal:work-turn-complete:${stepId} -->`;
}

/** Whether the artifact is well-formed (§27.12): present AND carrying the marker. `content` is the domain
 *  concept "the artifact's content" (null = absent/unreadable) — the fs read is the caller's, so this stays
 *  a pure predicate. */
export function artifactWellFormed(content: string | null, marker: string): boolean {
  return content !== null && content.includes(marker);
}

export interface AppWorkPromptReq {
  /** The def's work-recipe body (§27.8), already read from the confined recipe path. */
  recipeBody: string;
  /** The turn key the done-signal is scoped to (e.g. `work-plan`). */
  turnKey: string;
  /** The repo-relative §27 done-file path the agent writes last (`.agent-terminal/loop/turn-done`). */
  doneRelPath: string;
  /** The completion contract, discriminated by how the turn proves it produced its product (never a flat record
   *  with mode-dead fields, CODE-STANDARDS): `file` — end an artifact with a marker line (§27.12); `red`/`green`
   *  — write the §28.5.5 phase-result file the RED/GREEN gate classifies; `null` — a commit-producing turn
   *  (done-signal alone). `red` and `green` share the result-file shape, differing only in the bar the prose sets. */
  completion:
    | { kind: 'file'; artifactRel: string; marker: string }
    | { kind: 'red'; resultRel: string; checkCommand: string; redCheckCommand: string | null }
    | { kind: 'green'; resultRel: string; checkCommand: string }
    | { kind: 'refactor'; resultRel: string; checkCommand: string }
    | null;
  /** §27.9/AC5 — the operator's redo instruction, threaded as a clean-slate directive when a redo re-entered
   *  the work turn (ticket + plan + instruction only). Absent on an ordinary work run; a blank one emits no
   *  block (the caller passes only a `validInstruction` value). */
  instruction?: string;
  /** §27.10 — the carried inputs the prompt names (id + repo-relative path); the confined absolute path
   *  never reaches this type, so it cannot enter the prompt's vocabulary (§27.8). */
  inputs?: ChainedInput[];
  /** The GitHub issue this loop is working — the flow's resolved `github-ticket`, the SAME identity the gate
   *  side-effects act on (resolveAppGateRefs). Named in the prompt so the agent operates on THIS issue and
   *  never re-derives it from the current branch, open PR, or working directory (CLAUDE.md: the receiver never
   *  re-derives its target from ambient state). Absent when the flow resolved no ticket. */
  ticket?: number;
  /** §28.4.2 — the operator's back-to-RED brief for the slice this TDD phase turn belongs to. */
  sliceBrief?: SliceBrief;
  /** §27.3 */
  loopBrief?: string;
  /** §27.3 */
  goalReview?: string[];
  /** §27.3 */
  goalProgress?: string[];
  /** §27.10 */
  reportSections?: ReportSectionTarget[];
}

/** §27.10 — the file this step writes its section of report `id` to, and the assembled report itself. */
export interface ReportSectionTarget {
  id: string;
  sectionRel: string;
  reportRel: string;
}

/** §27.10 */
export const REPORT_SECTION_HEADING = 'REPORT SECTION';

/** §27.10 */
export function reportSectionLines(targets: ReportSectionTarget[]): string[] {
  return targets.flatMap((t) => [
    '',
    `${REPORT_SECTION_HEADING} — this step's part of \`${t.id}\` is its own file, ${t.sectionRel}. Write your whole section to that`,
    'file, and each time you update it, rewrite the whole file: never patch it in place.',
    `Never edit ${t.reportRel}: the app rebuilds it from every step's section file, in flow order, before each step reads it.`,
  ]);
}

export interface GoalLeg {
  leg: number;
  /** Review passes a leg runs before it checkpoints; absent runs the goal in one leg. */
  passes?: number;
}

/** §27.3 */
export function composeGoalCommand(req: { condition: string; promptRel: string; progressRel: string; turnKey: string; doneRelPath: string } & GoalLeg): string {
  const goal = req.condition.replace(/[.\s]+$/, '');
  const ends =
    req.passes !== undefined
      ? `so either this holds: ${goal}, or ${req.passes} review passes have run in this leg, or the session cannot go on without the operator`
      : `so either this holds: ${goal}, or the session cannot go on without the operator`;
  return (
    `/goal Every instruction in ${req.promptRel} is carried out for leg ${req.leg} of this goal, ${ends}; ` +
    `${req.progressRel} records which, and the last instruction writes ${req.doneRelPath} (turn-done:${req.turnKey}).`
  );
}

/** §27.3 */
export function checkpointCompactCommand(progressRel: string, notesRel: string): string {
  return `/compact Keep the goal, the decision boundary, and the progress in ${progressRel} and ${notesRel}: the next leg resumes from those files.`;
}

/** §27.3 */
export function goalProgressLines(req: { progressRel: string; notesRel: string; checkCommand: string } & GoalLeg): string[] {
  const f = GOAL_PROGRESS_FIELDS;
  const lines = [
    '',
    'PROGRESS — keep two files, so the goal survives a compaction or a restart.',
    `- ${req.progressRel} is JSON the app reads: \`${f.leg}\`, \`${f.status}\`, \`${f.passes}\` and, when blocked, \`${f.blocked}\`.`,
    `- ${req.notesRel} is your own notes: what is done, the open findings, and what comes next. The app never reads it.`,
    `This is leg ${req.leg} of the goal.`,
    req.leg > 1
      ? 'An earlier leg saved its progress in those files: read them first, carry on from the next steps, and do not redo finished work.'
      : 'If those files already record this leg, an earlier attempt at it was interrupted: carry on from them.',
    `After every review pass, rewrite both: the JSON with \`"${f.leg}": ${req.leg}\`, \`"${f.status}": "working"\` and the passes run so far,`,
    'and the notes.',
    `Before you write the done-signal, set \`${f.status}\` to one of:`,
    '- `"done"` when the goal holds.',
  ];
  if (req.passes !== undefined) {
    lines.push(
      `- \`"checkpoint"\` when ${req.passes} review passes have run in this leg and the goal does not hold yet. The app then`,
      `  compacts this session and starts leg ${req.leg + 1}, which resumes from these files.`,
    );
  }
  lines.push(
    `- \`"blocked"\` when you cannot go on without the operator. Put what you need from them, with your recommendation, in`,
    `  \`${f.blocked}\` as one JSON string. The step then stops for the operator, so use it only when no choice inside your`,
    '  decision boundary lets you go on. If the operator resolves what you were blocked on in this session, carry on',
    '  with the goal: when this leg ends, rewrite the progress file and then the done-signal; the step continues from there.',
    'Only `done` is held to the completion check and the verification the instructions below ask for before the',
    'done-signal. On `checkpoint` or `blocked`, write the done-signal once the progress file is written, whether or not',
    'that check holds yet.',
    `Before writing the done-signal, run this check from the repo root and fix ${req.progressRel} until it prints \`${ARTIFACT_CHECK_PASSED}\`.`,
    'It is the check the app ends this leg by, so a file it rejects does not end the leg:',
    '',
    `    ${req.checkCommand}`,
    '',
    `A well-formed ${req.progressRel}:`,
    '',
    exampleGoalProgress(req.leg, 'working').trimEnd(),
    '',
    `A ${req.notesRel}:`,
    '',
    exampleGoalNotes().trimEnd(),
  );
  return lines;
}

/** §28.4.2 — the back-to-RED brief as the work turn states it. */
export function sliceBriefLines(brief: SliceBrief, audience: 'work' | 'fixer'): string[] {
  const lead =
    audience === 'work'
      ? 'The RED, GREEN and refactor phases of this slice must each satisfy it — do this phase\'s part:'
      : 'Judge this round against it as well as the ticket, and record in the round report how the round serves it:';
  return [
    '',
    `REDO of impl-slice ${brief.slice} — the operator sent this slice back to RED from the ${brief.fromStep} gate with this brief.`,
    lead,
    '',
    brief.text,
  ];
}

/** §27.4 */
export function flowDocumentLines(code: 'working-tree' | 'described-elsewhere' = 'working-tree'): string[] {
  const dir = [...APP_LOOP_DIR_SEGMENTS, ARTIFACTS_SUBDIR].join('/');
  return [
    '',
    'FLOW DOCUMENTS — this work\'s flow documents (the groomed ticket, the plan, the RED/GREEN phase results) live',
    `only under \`${dir}/\`.`,
    "A file of that kind found elsewhere in the repository is not one of this work's flow documents, so never read",
    'it as one; it is still work when the ticket names it as something to change.',
    ...(code === 'working-tree'
      ? ["The code and tests a loop produces are the working-tree diff, and the repository's standards and", 'configuration are read where they live.']
      : ["The repository's standards and configuration are read where they live."]),
  ];
}

/** §27.3/§27.6 */
export function designCheckLines(): string[] {
  return [
    '',
    'BEFORE YOU ADD COMPLEXITY TO FIX SOMETHING — when a fix would add a special case, a flag, a workaround, a guard, or a',
    'second copy of logic, first ask whether the design itself is the problem: a format parsed by hand that could be',
    'structured data checked by one shared predicate, branches one rule would replace, a guard against a state the design',
    'could make impossible, a mechanism bigger than the ticket needs. If a simpler design removes the problem and stays',
    'inside this ticket, make that change instead. If it reaches beyond this ticket, do not widen the change: put it to a',
    'human the way this turn raises a decision for one. If the patch is still right, say why where you record the fix.',
    'Never redesign code that no fix touches.',
  ];
}

/** §27.3 — a goal session's result is judged only once it records the goal done, not at a checkpoint. */
const resultCheckMoment = (req: AppWorkPromptReq): string => (req.goalProgress !== undefined ? 'you record the goal done' : 'writing the done-signal');

/** Compose the §27 work-turn prompt (§27.3): the loop brief and the def's recipe body, then — for a
 *  file-producing turn — the instruction to end the artifact with the completion marker, then the shared
 *  done-signal instruction pointing at the §27 done-file (and, for a file-producing turn, verifying the
 *  artifact on disk first). */
export function composeAppWorkPrompt(req: AppWorkPromptReq): string {
  const parts = [...(req.loopBrief !== undefined ? [req.loopBrief.trimEnd(), ''] : []), req.recipeBody.trimEnd()];
  // Bind the turn to the engine-resolved issue (ticketPromptLines — one shared source across the work /
  // consolidate / review composers, so they cannot drift) — the SAME identity the gate's update-issue-body writes
  // to — so the agent works THIS ticket rather than one inferred from the branch, open PR, or cwd (CLAUDE.md: the
  // receiver never re-derives its target from ambient state). Above the redo block so a redo's "the ticket and
  // the plan above" reference covers it.
  if (req.ticket !== undefined) parts.push(...ticketPromptLines(req.ticket));
  parts.push(...flowDocumentLines(), ...designCheckLines());
  // §27.10 — above the redo block so a redo's "the ticket and the plan above" reference covers the
  // carried inputs.
  if (req.inputs && req.inputs.length > 0) {
    parts.push(
      '',
      "INPUTS — the artifact(s) found at this loop's declared input paths. Read each before you begin:",
      ...req.inputs.map((i) => `  - ${i.id}: ${i.rel}`),
    );
  }
  if (req.reportSections !== undefined) parts.push(...reportSectionLines(req.reportSections));
  // §27.9/AC5 — a redo re-enters the work turn on a clean slate: the recipe body (which sources the ticket and
  // the plan) still leads, and the operator's instruction is threaded as the redo directive. No findings and no
  // round history reach it — the boundary before the turn cleared the context; this block adds only the
  // instruction. A blank instruction never reaches here (the caller passes a `validInstruction` value only).
  if (req.instruction) {
    parts.push(
      '',
      'REDO — the operator asked you to redo the work from a clean slate. Start ONLY from the ticket and the plan',
      'above, discarding any prior findings, review rounds, or accumulated context, and follow this instruction:',
      '',
      req.instruction,
    );
  }
  if (req.sliceBrief !== undefined) parts.push(...sliceBriefLines(req.sliceBrief, 'work'));
  if (req.goalReview !== undefined) parts.push(...req.goalReview);
  if (req.goalProgress !== undefined) parts.push(...req.goalProgress);
  if (req.completion?.kind === 'file') {
    parts.push(
      '',
      `As the final line of your ${req.completion.artifactRel} artifact, write EXACTLY this marker line so`,
      'the orchestrator can confirm this turn produced it (it is not a judgement of quality):',
      req.completion.marker,
    );
  } else if (req.completion?.kind === 'red') {
    // §28.5.5 §7d — only the phase-specific bar prose (NOT derivable from the outcome) is spelled here.
    parts.push(
      '',
      ...composePhaseResultInstruction({
        resultRel: req.completion.resultRel,
        completingOutcome: RED_COMPLETING_OUTCOME,
        closing: [
          `This turn is a valid RED only when a test you ADDED fails by assertion (\`"${PHASE_RESULT_FIELDS.outcome}": "${RED_COMPLETING_OUTCOME}"\`).`,
          'A compile or import error (`errored`), a passing test (`passed`), or no test selected does NOT complete it —',
          'fix the test so it genuinely runs and fails on an assertion, then re-run and re-classify.',
          'The one exception is a slice whose behavior an earlier slice already built, so every test you added passes',
          'against the existing code: when your instructions let you record it as verification-only, write instead',
          '',
          examplePhaseResult(RED_VERIFICATION_OUTCOME, { verificationOnly: true }).trimEnd(),
          ...checkerLines(req.completion.checkCommand, 'phase result', resultCheckMoment(req)),
        ],
      }),
    );
    const command = req.completion.redCheckCommand;
    if (command !== null) {
      const resultRel = req.completion.resultRel;
      parts.push('', ...composeRedCheckInstruction({ command, reportRel: redCheckReportRel(resultRel), resultRel }));
    }
  } else if (req.completion?.kind === 'green') {
    // §28.5.3 §7d — only the phase-specific bar prose (NOT derivable from the outcome) is spelled here.
    const f = PHASE_RESULT_FIELDS;
    parts.push(
      '',
      ...composePhaseResultInstruction({
        resultRel: req.completion.resultRel,
        completingOutcome: GREEN_COMPLETING_OUTCOME,
        build: { completingBuildOutcome: GREEN_COMPLETING_BUILD_OUTCOME },
        closing: [
          `This turn is a valid GREEN only when the tests pass (\`"${f.outcome}": "${GREEN_COMPLETING_OUTCOME}"\`) AND the build succeeds (\`"${f.build}": "${GREEN_COMPLETING_BUILD_OUTCOME}"\`).`,
          'A failing or errored test, a broken build (`build-failed`), or any non-passing outcome does NOT complete it —',
          'fix the implementation so the tests pass and the build succeeds, then re-run and re-classify.',
          ...checkerLines(req.completion.checkCommand, 'phase result', resultCheckMoment(req)),
        ],
      }),
    );
  } else if (req.completion?.kind === 'refactor') {
    // §28.5.3
    parts.push(
      '',
      ...composePhaseResultInstruction({
        resultRel: req.completion.resultRel,
        completingOutcome: REFACTOR_COMPLETING_OUTCOME,
        closing: [
          `This turn is done only when the tests still pass (\`"${PHASE_RESULT_FIELDS.outcome}": "${REFACTOR_COMPLETING_OUTCOME}"\`).`,
          'A failing or errored test does NOT complete it — fix so the tests pass, then re-run and re-classify.',
          ...checkerLines(req.completion.checkCommand, 'phase result', resultCheckMoment(req)),
        ],
      }),
    );
  }
  const verifyRel =
    req.completion?.kind === 'file'
      ? req.completion.artifactRel
      : req.completion?.kind === 'red' || req.completion?.kind === 'green' || req.completion?.kind === 'refactor'
        ? req.completion.resultRel
        : undefined;
  parts.push('', doneSignalInstruction(req.turnKey, verifyRel, req.doneRelPath));
  return `${parts.join('\n')}\n`;
}
