// Per-step entry action (§18.3/§18.6/§19.3) — run on entry to a step. A `skill` step injects its
// invocation (§9.3), refusing over a busy shell (§19.3). A `bootstrap: pickup` step runs IN-APP pickup
// (§26.9 / L1) — out-of-band gh/git, NOT the retired §24.2.3 T3 terminal injection — so it is NOT gated
// by a busy shell. An unsatisfied required typed input (§18.4) returns a `prompt` instead of acting.
// Todo templates are NOT instantiated here — they are on-demand via the todoTemplate:* picker (§21.2).

import type { FlowStepDef } from './flow';
import type { FlowPrompt } from '../shared/ipc';

/** §19.3 running-process refusal message — surfaced as the returned transient notice (skill only). */
export const BUSY_NOTICE = 'agent is busy — wait or interrupt, then retry';

/** Names the in-app action a `bootstrap: pickup` step's input feeds (§26.9); shown in the modal helper. */
export const BOOTSTRAP_PICKUP = 'pickup';

/** A Claude Code skill is invoked as a slash command; a bare name gets the leading slash. */
export function skillInvocation(ref: string): string {
  return ref.startsWith('/') ? ref : `/${ref}`;
}

export interface FlowEntryActionDeps {
  /** True iff the shell is not at a ready prompt (§19.3, via OSC-133 / §8.3 quiescence). */
  isShellBusy(): boolean;
  /** Inject a skill invocation into the terminal (§9.3). */
  inject(text: string): void;
  /** Run in-app bootstrap (pickup) for a `bootstrap: pickup` step (§26.9), given the resolved required
   *  inputs. Out-of-band gh/git + state.yaml write — never terminal injection, never busy-gated. */
  runPickup(step: FlowStepDef, inputs: Record<string, string>): void;
}

/** A transient result surfaced on the transition's returned view: the §19.3 refusal `notice` (skill),
 *  or a `prompt` for an unsatisfied required input (§18.4) the renderer must collect before bootstrap. */
export interface EntryActionResult {
  notice?: string;
  prompt?: FlowPrompt;
}

/** Run a step's entry actions, given the flow's resolved typed inputs (§18.4) threaded from
 *  flow-state. `inputs` is empty before anything is resolved (so a required input prompts). */
export type FlowEntryActions = (step: FlowStepDef, inputs?: Record<string, string>) => EntryActionResult;

export function createFlowEntryActions(deps: FlowEntryActionDeps): FlowEntryActions {
  return (step, inputs = {}) => {
    // OWN property only: a prototype-chain key (e.g. an input named `__proto__`) must not resolve to a
    // truthy object. A blank/whitespace value counts as unsatisfied (§18.4).
    const resolved = (name: string): string => {
      if (!Object.prototype.hasOwnProperty.call(inputs, name)) return '';
      const v = inputs[name];
      return typeof v === 'string' ? v.trim() : '';
    };
    if (step.skill) {
      if (deps.isShellBusy()) return { notice: BUSY_NOTICE };
      deps.inject(skillInvocation(step.skill));
    }
    if (step.bootstrap === 'pickup') {
      const required = (step.inputs ?? []).filter((i) => i.required);
      const missing = required.filter((i) => resolved(i.name) === '');
      if (missing.length > 0) {
        return { prompt: { inputs: missing.map(({ name, type }) => ({ name, type })), bootstrap: BOOTSTRAP_PICKUP } };
      }
      // §26.9: in-app pickup is out-of-band gh/git; it runs regardless of the shell being busy. Forward
      // the trimmed required inputs so the runner can resolve the github-ticket issue number.
      const resolvedInputs: Record<string, string> = {};
      for (const i of required) resolvedInputs[i.name] = resolved(i.name);
      deps.runPickup(step, resolvedInputs);
    }
    return {};
  };
}
