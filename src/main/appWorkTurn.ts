// §27.3/§27.7/§27.8/§27.12 — the pure, data-driven pieces of the §27 work turn, kept out of the engine so
// they are asserted from the outside: the boundary-policy→command mapping (boundaries are data, §27.7); the
// completion-artifact resolver (read from the def's declared artifact, never a hard-coded loop name); the
// completion marker the work prompt instructs and the completion check reads (ONE definition, so the
// writer↔reader cannot desync — CLAUDE.md shared-semantics); and the work-prompt composer.

import { doneSignalInstruction } from '../shared/loopTurn';
import type { BoundaryPolicy, LoopDefV2 } from './loopDefV2';

/** The instance command a boundary policy issues (§27.7). `clear` resets context; `compact` carries the
 *  def's message naming what must survive it. The graded observable is the command issued + the idle
 *  confirm (§27.12b), not the agent-internal effect of compaction. */
export function boundaryCommand(policy: BoundaryPolicy): string {
  return policy.mode === 'compact' ? `/compact ${policy.message}` : '/clear';
}

/** The completion artifact the work turn must produce, resolved from the def (§27.12): the confined output
 *  binding whose id matches `work.artifact`. Null when no output backs that id — a commit-producing loop
 *  whose product is commits, which advances on the done-signal alone. Data-driven: never a loop-name check. */
export function completionArtifact(def: LoopDefV2): { path: string } | null {
  const binding = def.outputs.find((o) => o.id === def.work.artifact);
  return binding ? { path: binding.path } : null;
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
  /** The file-producing completion contract, or null for a commit-producing turn (done-signal alone). */
  completion: { artifactRel: string; marker: string } | null;
  /** §27.9/AC5 — the operator's redo instruction, threaded as a clean-slate directive when a redo re-entered
   *  the work turn (ticket + plan + instruction only). Absent on an ordinary work run; a blank one emits no
   *  block (the caller passes only a `validInstruction` value). */
  instruction?: string;
}

/** Compose the §27 work-turn prompt (§27.3): the def's recipe body, then — for a file-producing turn — the
 *  instruction to end the artifact with the completion marker, then the shared done-signal instruction
 *  pointing at the §27 done-file (and, for a file-producing turn, verifying the artifact on disk first). */
export function composeAppWorkPrompt(req: AppWorkPromptReq): string {
  const parts = [req.recipeBody.trimEnd()];
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
  if (req.completion) {
    parts.push(
      '',
      `As the final line of your ${req.completion.artifactRel} artifact, write EXACTLY this marker line so`,
      'the orchestrator can confirm this turn produced it (it is not a judgement of quality):',
      req.completion.marker,
    );
  }
  parts.push('', doneSignalInstruction(req.turnKey, req.completion?.artifactRel, req.doneRelPath));
  return `${parts.join('\n')}\n`;
}
