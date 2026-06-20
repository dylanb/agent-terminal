// Per-step entry action (§18.3/§18.6/§19.3) — run on entry to a step (Start/Restart/Advance-into).
// Two automatic actions: injecting the step's `skill` invocation (§9.3), and running a `bootstrap:
// pickup` (§18.3 — inject `agent-loop pickup <input>`). Both refuse over a busy shell (§19.3): the
// shell is not at a ready prompt while a foreground process runs, so we stop and tell the user
// rather than typing over it. A `bootstrap` whose required typed input (§18.4) is unsatisfied does
// not inject — it returns a `prompt` so the renderer's modal collects the value first (flow:provideInput
// re-enters once it is provided). Todo templates are NOT instantiated here — they are instantiated
// ON DEMAND via the todoTemplate:* picker while the step is active (spec §6/§4.1, §21.2).
// The runner is pure orchestration over injected primitives so it unit-tests with fakes; the
// wiring layer (index.ts) supplies the real busy probe and injector.

import type { FlowStepDef } from './flow';
import type { FlowPrompt } from '../shared/ipc';

/** §19.3 running-process refusal message — surfaced as the returned transient notice. */
export const BUSY_NOTICE = 'agent is busy — wait or interrupt, then retry';

/** The bootstrap command a `bootstrap: pickup` step runs on entry (§18.3); the resolved inputs are
 *  appended as arguments. Also the modal's helper text naming what the input feeds. */
export const BOOTSTRAP_PICKUP = 'agent-loop pickup';

/** A Claude Code skill is invoked as a slash command; a bare name gets the leading slash. */
export function skillInvocation(ref: string): string {
  return ref.startsWith('/') ? ref : `/${ref}`;
}

export interface FlowEntryActionDeps {
  /** True iff the shell is not at a ready prompt (§19.3, via OSC-133 / §8.3 quiescence). */
  isShellBusy(): boolean;
  /** Inject the skill invocation / bootstrap command into the terminal (§9.3). */
  inject(text: string): void;
}

/** A transient result surfaced on the transition's returned view: the §19.3 refusal `notice`, or a
 *  `prompt` for an unsatisfied required input (§18.4) the renderer must collect before the bootstrap. */
export interface EntryActionResult {
  notice?: string;
  prompt?: FlowPrompt;
}

/** Run a step's entry actions, given the flow's resolved typed inputs (§18.4) threaded from
 *  flow-state. `inputs` is empty before anything is resolved (so a required input prompts). */
export type FlowEntryActions = (step: FlowStepDef, inputs?: Record<string, string>) => EntryActionResult;

export function createFlowEntryActions(deps: FlowEntryActionDeps): FlowEntryActions {
  return (step, inputs = {}) => {
    if (step.skill) {
      if (deps.isShellBusy()) return { notice: BUSY_NOTICE };
      deps.inject(skillInvocation(step.skill));
    }
    if (step.bootstrap === 'pickup') {
      const required = (step.inputs ?? []).filter((i) => i.required);
      const missing = required.filter((i) => !inputs[i.name]);
      if (missing.length > 0) {
        return { prompt: { inputs: missing.map(({ name, type }) => ({ name, type })), bootstrap: BOOTSTRAP_PICKUP } };
      }
      if (deps.isShellBusy()) return { notice: BUSY_NOTICE };
      deps.inject([BOOTSTRAP_PICKUP, ...required.map((i) => inputs[i.name])].join(' '));
    }
    return {};
  };
}
