// §26.5 / §26.3 — composes a work-{phase} actor-turn prompt from the bound LoopDef recipe. L2 is the
// minimal-but-real slice: the template body (`prompts/work-{phase}.md`) + token substitution + the
// appended done-signal instruction (§26.3/D47a). Fuller recipe assembly (charter blocks, skills,
// artifact slots) belongs to the reviewer/consolidate slices (L3/L4); this is the work turn only.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveLoopDir } from './loopDef';
import { doneSignalInstruction } from '../shared/loopTurn';

export interface WorkPromptRequest {
  repoDir: string;
  loopName: string;
  /** Phase id whose template is `prompts/work-{phase}.md` (e.g. `plan`). */
  phase: string;
  /** Turn key the done-signal is scoped to (e.g. `work-plan`). */
  turnKey: string;
  /** `{{TOKEN}}` → value substitutions resolved by the host from state + LoopDef config bindings. */
  tokens: Record<string, string>;
  configDir?: string;
}

/** Compose the work-turn prompt, or null when the loop name is unsafe or the phase template is absent
 *  (the recipe's `on_missing: fail` for the template-file slot — the orchestrator treats null as a
 *  config error). */
export function composeWorkPrompt(req: WorkPromptRequest): string | null {
  const loopDir = resolveLoopDir(req.repoDir, req.loopName, req.configDir);
  if (loopDir === null) return null;
  const templatePath = path.join(loopDir, 'prompts', `work-${req.phase}.md`);
  let body: string;
  try {
    body = readFileSync(templatePath, 'utf8');
  } catch {
    return null;
  }
  for (const [token, value] of Object.entries(req.tokens)) {
    body = body.split(`{{${token}}}`).join(value);
  }
  return `${body}\n${doneSignalInstruction(req.turnKey)}\n`;
}

export interface SpawnReviewersRequest {
  /** Phase id whose roster is fanned out (e.g. `plan`). */
  phase: string;
  /** Current iteration — scopes each persona's output path `reviews/{iteration}/{persona}.json`. */
  iteration: number;
  /** The resolved roster persona actors (§26.4), in order. */
  personas: string[];
  /** Turn key the done-signal is scoped to (e.g. `review-plan`). */
  turnKey: string;
}

/** §26.4 — compose the single spawn-reviewers prompt (no template file: composed by main). It names each
 *  roster persona and its iteration-scoped review JSON, instructs the instance to spawn them as parallel
 *  `Task` subagents, and appends the done-signal instruction that fires once all subagents have returned. */
export function composeSpawnReviewersPrompt(req: SpawnReviewersRequest): string {
  const lines = [
    `Review the current ${req.phase} artifacts by spawning the following reviewer personas as PARALLEL Task`,
    'subagents — one Task per persona, all launched together, each an independent fresh context. Each',
    'subagent loads its review skill, reviews the work, and writes its verdict JSON to the path shown:',
    '',
    ...req.personas.map((p) => `  - ${p} → .agent-loop/reviews/${req.iteration}/${p}.json`),
    '',
    'Wait for every subagent to return before finishing this turn.',
    doneSignalInstruction(req.turnKey),
  ];
  return `${lines.join('\n')}\n`;
}
