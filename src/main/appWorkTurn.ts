// §27.3/§27.7/§27.8/§27.12 — the pure, data-driven pieces of the §27 work turn, kept out of the engine so
// they are asserted from the outside: the boundary-policy→command mapping (boundaries are data, §27.7); the
// completion-artifact resolver (read from the def's declared artifact, never a hard-coded loop name); the
// completion marker the work prompt instructs and the completion check reads (ONE definition, so the
// writer↔reader cannot desync — CLAUDE.md shared-semantics); and the work-prompt composer.

import { doneSignalInstruction } from '../shared/loopTurn';
import type { BoundaryPolicy, LoopDefV2 } from './loopDefV2';
import type { ChainedInput } from './chainedInput';
import { PHASE_RESULT_GRAMMAR, composePhaseResultInstruction } from '../shared/phaseResult';
import { ticketPromptLines } from '../shared/currentTicket';
import { RED_COMPLETING_OUTCOME, GREEN_COMPLETING_OUTCOME } from '../shared/phaseOutcome';
import { GREEN_COMPLETING_BUILD_OUTCOME } from '../shared/buildOutcome';

/** The instance command a boundary policy issues (§27.7). `clear` resets context; `compact` carries the
 *  def's message naming what must survive it. The graded observable is the command issued + the idle
 *  confirm (§27.12b), not the agent-internal effect of compaction. */
export function boundaryCommand(policy: BoundaryPolicy): string {
  // policy.message is repo-authored (loopDefV2 applies requireString only) and this command is submitted as
  // one line, so collapse every CR/LF before interpolating — a newline would otherwise inject a second
  // command line into the agent's instruction channel (CWE-74, §B.13d).
  return policy.mode === 'compact' ? `/compact ${(policy.message ?? '').replace(/[\r\n]+/g, ' ')}` : '/clear';
}

/** The completion artifact the work turn must produce, resolved from the def (§27.12): the confined output
 *  binding whose id matches `work.artifact`. Null when no output backs that id — a commit-producing loop
 *  whose product is commits, which advances on the done-signal alone. Data-driven: never a loop-name check. */
export function completionArtifact(def: LoopDefV2): { path: string; rel: string } | null {
  const binding = def.outputs.find((o) => o.id === def.work.artifact);
  return binding ? { path: binding.path, rel: binding.rel } : null;
}

/** Insert `.slice-N` before the final extension of a path's last segment: `.../red-result.md` →
 *  `.../red-result.slice-2.md`. Only the basename is rewritten (the directory is untouched), and `slice` is a
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
    | { kind: 'red'; resultRel: string }
    | { kind: 'green'; resultRel: string }
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
}

/** Compose the §27 work-turn prompt (§27.3): the def's recipe body, then — for a file-producing turn — the
 *  instruction to end the artifact with the completion marker, then the shared done-signal instruction
 *  pointing at the §27 done-file (and, for a file-producing turn, verifying the artifact on disk first). */
export function composeAppWorkPrompt(req: AppWorkPromptReq): string {
  const parts = [req.recipeBody.trimEnd()];
  // Bind the turn to the engine-resolved issue (ticketPromptLines — one shared source across the work /
  // consolidate / review composers, so they cannot drift) — the SAME identity the gate's update-issue-body writes
  // to — so the agent works THIS ticket rather than one inferred from the branch, open PR, or cwd (CLAUDE.md: the
  // receiver never re-derives its target from ambient state). Above the redo block so a redo's "the ticket and
  // the plan above" reference covers it.
  if (req.ticket !== undefined) parts.push(...ticketPromptLines(req.ticket));
  // §27.10 — above the redo block so a redo's "the ticket and the plan above" reference covers the
  // carried inputs.
  if (req.inputs && req.inputs.length > 0) {
    parts.push(
      '',
      "INPUTS — the artifact(s) found at this loop's declared input paths. Read each before you begin:",
      ...req.inputs.map((i) => `  - ${i.id}: ${i.rel}`),
    );
  }
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
  if (req.completion?.kind === 'file') {
    parts.push(
      '',
      `As the final line of your ${req.completion.artifactRel} artifact, write EXACTLY this marker line so`,
      'the orchestrator can confirm this turn produced it (it is not a judgement of quality):',
      req.completion.marker,
    );
  } else if (req.completion?.kind === 'red') {
    // §28.5.5 §7d — the RED phase-result instruction, composed by the shared writer (composePhaseResultInstruction:
    // grammar tokens + outcome vocabulary from the descriptors, the canonical few-shot embedded fence-free). Only
    // the phase-specific bar prose (NOT derivable from the outcome) is spelled here and threaded as `closing`.
    const g = PHASE_RESULT_GRAMMAR;
    parts.push(
      '',
      ...composePhaseResultInstruction({
        resultRel: req.completion.resultRel,
        completingOutcome: RED_COMPLETING_OUTCOME,
        closing: [
          `This turn is a valid RED only when a test you ADDED fails by assertion (\`${g.outcomeLabel}: ${RED_COMPLETING_OUTCOME}\`).`,
          'A compile or import error (`errored`), a passing test (`passed`), or no test selected does NOT complete it —',
          'fix the test so it genuinely runs and fails on an assertion, then re-run and re-classify.',
        ],
      }),
    );
  } else if (req.completion?.kind === 'green') {
    // §28.5.3 §7d — the GREEN phase-result instruction: the same shared writer, additionally classifying the
    // build (`build:`) via `build`. The phase-specific bar prose is threaded as `closing`.
    const g = PHASE_RESULT_GRAMMAR;
    parts.push(
      '',
      ...composePhaseResultInstruction({
        resultRel: req.completion.resultRel,
        completingOutcome: GREEN_COMPLETING_OUTCOME,
        build: { completingBuildOutcome: GREEN_COMPLETING_BUILD_OUTCOME },
        closing: [
          `This turn is a valid GREEN only when the tests pass (\`${g.outcomeLabel}: ${GREEN_COMPLETING_OUTCOME}\`) AND the build succeeds (\`${g.buildLabel}: ${GREEN_COMPLETING_BUILD_OUTCOME}\`).`,
          'A failing or errored test, a broken build (`build-failed`), or any non-passing outcome does NOT complete it —',
          'fix the implementation so the tests pass and the build succeeds, then re-run and re-classify.',
        ],
      }),
    );
  }
  const verifyRel =
    req.completion?.kind === 'file'
      ? req.completion.artifactRel
      : req.completion?.kind === 'red' || req.completion?.kind === 'green'
        ? req.completion.resultRel
        : undefined;
  parts.push('', doneSignalInstruction(req.turnKey, verifyRel, req.doneRelPath));
  return `${parts.join('\n')}\n`;
}
