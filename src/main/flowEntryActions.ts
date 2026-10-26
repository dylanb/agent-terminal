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

/** The seam's ONE domain answer for a loop step's binding: `ready` (the binding
 *  resolved; a `notice` carries AC 5's def migration, position 6), or `refuse` (positions 2/4/5 — the def
 *  did not resolve, a declared bootstrap the def cannot satisfy, or the runner cannot accept a turn now).
 *  A refuse's operator-facing surface — the resolver reason on the loop-error path, the deferred revert and
 *  its `pushFlowChanged` — lives in the index.ts implementation of this dep (where the resolver and flow
 *  machine are), so the seam branches on the domain answer and re-derives nothing (CLAUDE.md injection-seam). */
export type LoopBindingResult = { kind: 'ready'; notice?: string } | { kind: 'refuse' };

export interface FlowEntryActionDeps {
  /** True iff the shell is not at a ready prompt (§19.3, via OSC-133 / §8.3 quiescence). */
  isShellBusy(): boolean;
  /** Inject a manual step's skill invocation into the terminal (§9.3). */
  inject(text: string): void;
  /** Resolve (and, on the app-bundled tier, migrate) the step's loop binding.
   *  Called once, after the marked-binding (position 1) and required-input (position 3) gates, so its
   *  migration side effect never fires on an entry that returns a prompt. */
  prepareLoopBinding(step: FlowStepDef): LoopBindingResult;
  /** §27.15 — dispatch a ready loop binding: inject the step's skill (submitted, for a
   *  def with no `pickup:` block) and start the §27 work turn / bootstrap. Owns the skill/bootstrap/dispatch
   *  ordering (AC 10), where the resolved def's `pickup:` block is known. */
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
      // AC 4 marked binding: a `legacy` binding names no surviving engine, so entry does
      // NOTHING (nothing resolved, injected or dispatched). Its error is the loop view's.
      if (bindsNoSurvivingEngine(step.loopNamespace ?? DEFAULT_LOOP_NAMESPACE)) return {};
      // An unsatisfied required input prompts ALONE, hoisted above the binding prep (whose
      // migration side effect must not fire on a prompt entry) and the dispatch, so answering it (which
      // re-runs enter) cannot double-fire the §27 entry or drop an accumulated notice.
      if (missing.length > 0) {
        return { prompt: { inputs: missing.map(({ name, type }) => ({ name, type })), bootstrap: BOOTSTRAP_PICKUP } };
      }
      // Resolve (and migrate) the binding. A refuse's surface/revert/push happened
      // in the dep's impl; the seam only stops dispatching. A ready binding's notice is AC 5's migration
      // notice (position 6), forwarded on the transition reply.
      const binding = deps.prepareLoopBinding(step);
      if (binding.kind === 'refuse') return {};
      // The dispatch owns the skill injection (submitted) and bootstrap/dispatch.
      deps.enterAppLoop(step);
      return binding.notice !== undefined ? { notice: binding.notice } : {};
    }
    if (step.skill) {
      if (deps.isShellBusy()) return { notice: BUSY_NOTICE };
      deps.inject(skillInvocation(step.skill));
    }
    return {};
  };
}
