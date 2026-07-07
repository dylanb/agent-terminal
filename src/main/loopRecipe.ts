// §26.5 / §26.3 — composes the orchestrator's actor-turn prompts from the bound LoopDef recipe: the
// work turn and the consolidate turn from their template files (`prompts/work-{phase}.md`,
// `prompts/consolidate.md`) + token substitution, and the spawn-reviewers turn from main (no template,
// §26.4). Every turn appends the done-signal instruction (§26.3/D47a). Charter blocks, skills, and the
// full artifact-slot recipe remain unmodeled — the minimal-but-real slice.

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

/** Assemble one actor-turn prompt from a LoopDef template file (§26.5 recipe: template body + token
 *  substitution + the appended done-signal instruction). Null when the loop name is unsafe or the
 *  template is absent — the recipe's `on_missing: fail` for the template-file slot, which the
 *  orchestrator treats as a config error. */
function assembleFromTemplate(
  repoDir: string,
  loopName: string,
  templateRel: string,
  tokens: Record<string, string>,
  turnKey: string,
  configDir?: string,
  artifact?: string,
): string | null {
  const loopDir = resolveLoopDir(repoDir, loopName, configDir);
  if (loopDir === null) return null;
  let body: string;
  try {
    body = readFileSync(path.join(loopDir, templateRel), 'utf8');
  } catch {
    return null;
  }
  for (const [token, value] of Object.entries(tokens)) {
    body = body.split(`{{${token}}}`).join(value);
  }
  return `${body}\n${doneSignalInstruction(turnKey, artifact)}\n`;
}

/** Compose the work-turn prompt, or null when the loop name is unsafe or the phase template is absent
 *  (the recipe's `on_missing: fail` for the template-file slot — the orchestrator treats null as a
 *  config error). */
export function composeWorkPrompt(req: WorkPromptRequest): string | null {
  return assembleFromTemplate(
    req.repoDir,
    req.loopName,
    path.join('prompts', `work-${req.phase}.md`),
    req.tokens,
    req.turnKey,
    req.configDir,
    // The work turn's completion artifact the orchestrator checks (§26.3): the agent verifies it on disk
    // before signalling done, so a plan that was never written cannot be reported complete.
    path.join('.agent-loop', 'plan.md'),
  );
}

export interface ConsolidatePromptRequest {
  repoDir: string;
  loopName: string;
  /** Phase id reviewed (e.g. `plan`) — the `{{PHASE}}` slot. */
  phase: string;
  /** Current iteration — the `{{ITERATION}}` slot and the `{{REVIEW_DIR}}` (`reviews/{iter}`) it reads. */
  iteration: number;
  /** Turn key the done-signal is scoped to (e.g. `consolidate-plan`). */
  turnKey: string;
  /** Caller-resolved slots not derivable here: `{{CLEAN_POLICY}}` (the verdict taxonomy anchor, §26.3
   *  D45) and `{{SEVERITY_FLOOR}}` (v1 omits the ladder, §26.5, so a static default). */
  tokens: Record<string, string>;
  configDir?: string;
}

/** §26.3/D45 — compose the consolidate-turn prompt from the LoopDef's `prompts/consolidate.md` template.
 *  The `{{ITERATION}}`/`{{PHASE}}`/`{{REVIEW_DIR}}` slots are filled from the request; the verdict-policy
 *  slots (`{{CLEAN_POLICY}}`/`{{SEVERITY_FLOOR}}`) come from the caller. Null on an unsafe loop name or a
 *  missing template, exactly like the work prompt. */
export function composeConsolidatePrompt(req: ConsolidatePromptRequest): string | null {
  const tokens: Record<string, string> = {
    ITERATION: String(req.iteration),
    PHASE: req.phase,
    REVIEW_DIR: path.join('.agent-loop', 'reviews', String(req.iteration)),
    ...req.tokens,
  };
  return assembleFromTemplate(
    req.repoDir,
    req.loopName,
    path.join('prompts', 'consolidate.md'),
    tokens,
    req.turnKey,
    req.configDir,
    // The consolidate turn's completion artifact the orchestrator checks (§26.3/D45): the agent verifies
    // consolidated.json is actually on disk before signalling done — the motivating "thinks it wrote the
    // file but did not" case, which otherwise detects done against a missing file → retry → error.
    path.join(tokens.REVIEW_DIR, 'consolidated.json'),
  );
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
    // Each persona's review JSON is the completion artifact the orchestrator checks (§26.4): the agent
    // verifies every one is on disk before signalling done, so a subagent that failed to write its verdict
    // is caught here rather than reported complete against a missing file.
    doneSignalInstruction(req.turnKey, `every persona's review JSON listed above under .agent-loop/reviews/${req.iteration}/`),
  ];
  return `${lines.join('\n')}\n`;
}
