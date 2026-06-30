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

/** Compose the work-turn prompt, or null when the phase template is absent (the recipe's
 *  `on_missing: fail` for the template-file slot — the orchestrator treats null as a config error). */
export function composeWorkPrompt(req: WorkPromptRequest): string | null {
  const templatePath = path.join(resolveLoopDir(req.repoDir, req.loopName, req.configDir), 'prompts', `work-${req.phase}.md`);
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
