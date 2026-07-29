// Per-step entry action (§18.3/§18.6/§19.3) — run on entry to a step. A manual `skill` step injects its
// invocation (§9.3), refusing over a busy shell (§19.3). A loop step is the §27 engine's: a surviving
// binding is routed to `enterAppLoop` (which resolves the def and orders the skill/bootstrap/dispatch),
// while a `legacy`-marked binding names no surviving engine (AC 4) so its entry does nothing. An unsatisfied
// required typed input (§18.4) returns a `prompt` instead of acting. Todo templates are NOT instantiated
// here — they are on-demand via the todoTemplate:* picker (§21.2).

import type { FlowStepDef } from './flow';
import type { FlowPrompt } from '../shared/ipc';
import { DEFAULT_LOOP_NAMESPACE, bindsNoSurvivingEngine } from '../shared/loopNamespace';

/** §19.3 running-process refusal message — surfaced as the returned transient notice (skill only). */
export const BUSY_NOTICE = 'agent is busy — wait or interrupt, then retry';

/** Names the in-app action a loop step's bootstrap input feeds; shown in the modal helper. */
export const BOOTSTRAP_PICKUP = 'pickup';

/** A Claude Code skill is invoked as a slash command; a bare name gets the leading slash. */
export function skillInvocation(ref: string): string {
  return ref.startsWith('/') ? ref : `/${ref}`;
}

/** A LOOP step's skill invocation, ready to inject as ONE submitted line: `skillInvocation`'s value with
 *  every run of CR/LF collapsed to a single space (CWE-74). A repo-authored `skill:` scalar can carry a
 *  newline, and a loop step's injection is submitted by the app (it supplies the final Enter), so an
 *  un-collapsed value would submit N command lines with zero operator keystrokes. Collapse, not reject:
 *  AC 10's clause is that the skill IS injected. Called ONLY at the two loop injection points (the §27
 *  entry's no-`pickup` arm and the bootstrap coordinator's hand-off — both in `index.ts`); the manual-step
 *  arm keeps `skillInvocation`'s value byte-identical, because there the operator presses Enter (§18.4). */
export function injectableSkill(ref: string): string {
  return skillInvocation(ref).replace(/[\r\n]+/g, ' ');
}

export interface FlowEntryActionDeps {
  /** True iff the shell is not at a ready prompt (§19.3, via OSC-133 / §8.3 quiescence). */
  isShellBusy(): boolean;
  /** Inject a manual step's skill invocation into the terminal (§9.3). */
  inject(text: string): void;
  /** §27.15 — a loop step binds the §27 engine. Called for a surviving binding once any required input is
   *  satisfied, so entering it resolves the def and starts the §27 work turn (§27.3). The §27 entry owns
   *  what the entry does — the skill/bootstrap/dispatch ordering (AC 10) and the run-less/failure view. */
  enterAppLoop(step: FlowStepDef): void;
}

/** A transient result surfaced on the transition's returned view: the §19.3 refusal `notice` (skill),
 *  or a `prompt` for an unsatisfied required input (§18.4) the renderer must collect before entry. */
export interface EntryActionResult {
  notice?: string;
  prompt?: FlowPrompt;
}

/** Run a step's entry actions, given the flow's resolved typed inputs (§18.4) threaded from
 *  flow-state. `inputs` is empty before anything is resolved (so a required input prompts). */
export type FlowEntryActions = (step: FlowStepDef, inputs?: Record<string, string>) => EntryActionResult;

export function createFlowEntryActions(deps: FlowEntryActionDeps): FlowEntryActions {
  return (step, inputs = {}) => {
    const resolved = (name: string): string => {
      // OWN property only: a prototype-chain key (e.g. an input named `__proto__`) must not resolve to a
      // truthy object. A blank/whitespace value counts as unsatisfied (§18.4).
      if (!Object.prototype.hasOwnProperty.call(inputs, name)) return '';
      const v = inputs[name];
      return typeof v === 'string' ? v.trim() : '';
    };
    const required = (step.inputs ?? []).filter((i) => i.required);
    const missing = required.filter((i) => resolved(i.name) === '');
    if (step.kind === 'loop') {
      // AC 4 marked binding: a `legacy` binding names no surviving engine, so entry does NOTHING — no
      // injection with nothing to submit it, no dispatch (§B.5 item 1). Its error is the loop view's (§B.4).
      if (bindsNoSurvivingEngine(step.loopNamespace ?? DEFAULT_LOOP_NAMESPACE)) return {};
      // §18.4: an unsatisfied required input prompts ALONE, above the entry, so answering it (which re-runs
      // enter) cannot double-fire the §27 entry (§B.5 item 3).
      if (missing.length > 0) {
        return { prompt: { inputs: missing.map(({ name, type }) => ({ name, type })), bootstrap: BOOTSTRAP_PICKUP } };
      }
      deps.enterAppLoop(step);
      return {};
    }
    if (step.skill) {
      if (deps.isShellBusy()) return { notice: BUSY_NOTICE };
      deps.inject(skillInvocation(step.skill));
    }
    return {};
  };
}
