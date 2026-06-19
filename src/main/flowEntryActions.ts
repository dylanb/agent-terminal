// Per-step entry action (§18.3/§18.6/§19.3) — run on entry to a manual step (Start/Restart). The
// ONLY automatic entry action is injecting the step's `skill` invocation (§9.3), and that UNLESS
// the shell is busy: §19.3 refuses injection while a foreground process runs (not at a ready
// prompt) and tells the user. Todo templates are NOT instantiated here — they are instantiated
// ON DEMAND via the todoTemplate:* picker while the step is active (spec §6/§4.1, §21.2).
// The runner is pure orchestration over injected primitives so it unit-tests with fakes; the
// wiring layer (index.ts) supplies the real busy probe and injector.

import type { FlowStepDef } from './flow';

/** §19.3 running-process refusal message — surfaced as the returned transient notice. */
export const BUSY_NOTICE = 'agent is busy — wait or interrupt, then retry';

/** A Claude Code skill is invoked as a slash command; a bare name gets the leading slash. */
export function skillInvocation(ref: string): string {
  return ref.startsWith('/') ? ref : `/${ref}`;
}

export interface FlowEntryActionDeps {
  /** True iff the shell is not at a ready prompt (§19.3, via OSC-133 / §8.3 quiescence). */
  isShellBusy(): boolean;
  /** Inject the skill invocation into the terminal (§9.3). */
  inject(text: string): void;
}

/** A transient result surfaced on the transition's returned view (e.g. the §19.3 refusal). */
export interface EntryActionResult {
  notice?: string;
}

export type FlowEntryActions = (step: FlowStepDef) => EntryActionResult;

export function createFlowEntryActions(deps: FlowEntryActionDeps): FlowEntryActions {
  return (step) => {
    if (step.skill) {
      if (deps.isShellBusy()) return { notice: BUSY_NOTICE };
      deps.inject(skillInvocation(step.skill));
    }
    return {};
  };
}
