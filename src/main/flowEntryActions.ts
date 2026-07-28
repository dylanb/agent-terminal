// Per-step entry action (§18.3/§18.6/§19.3) — run on entry to a step. A `skill` step injects its
// invocation (§9.3), refusing over a busy shell (§19.3). A `bootstrap: pickup` step runs IN-APP pickup
// (§26.9 / L1) — out-of-band gh/git, NOT the retired §24.2.3 T3 terminal injection — so it is NOT gated
// by a busy shell. An unsatisfied required typed input (§18.4) returns a `prompt` instead of acting.
// Todo templates are NOT instantiated here — they are on-demand via the todoTemplate:* picker (§21.2).

import type { FlowStepDef } from './flow';
import type { FlowPrompt } from '../shared/ipc';
import { APP_LOOP_NAMESPACE } from '../shared/loopNamespace';

/** §19.3 running-process refusal message — surfaced as the returned transient notice (skill only). */
export const BUSY_NOTICE = 'agent is busy — wait or interrupt, then retry';

/** Names the in-app action a `bootstrap: pickup` step's input feeds (§26.9); shown in the modal helper. */
export const BOOTSTRAP_PICKUP = 'pickup';

/** A Claude Code skill is invoked as a slash command; a bare name gets the leading slash. */
export function skillInvocation(ref: string): string {
  return ref.startsWith('/') ? ref : `/${ref}`;
}

/** A LOOP step's skill invocation, ready to inject as ONE submitted line: `skillInvocation`'s value with
 *  every run of CR/LF collapsed to a single space (CWE-74). A repo-authored `skill:` scalar can carry a
 *  newline, and a loop step's injection is submitted by the app (it supplies the final Enter), so an
 *  un-collapsed value would submit N command lines with zero operator keystrokes. Collapse, not reject:
 *  AC 10's clause is that the skill IS injected. Called ONLY at the two loop injection points (the seam's
 *  loop-step arm and the bootstrap coordinator's hand-off); the manual-step arm keeps `skillInvocation`'s
 *  value byte-identical, because there the operator is the one who presses Enter (§B.5 item 3, #98 non-goal). */
export function injectableSkill(ref: string): string {
  return skillInvocation(ref).replace(/[\r\n]+/g, ' ');
}

export interface FlowEntryActionDeps {
  /** True iff the shell is not at a ready prompt (§19.3, via OSC-133 / §8.3 quiescence). */
  isShellBusy(): boolean;
  /** Inject a skill invocation into the terminal (§9.3). */
  inject(text: string): void;
  /** Run in-app bootstrap (pickup) for a `bootstrap: pickup` step (§26.9), given the resolved required
   *  inputs. Out-of-band gh/git + state.yaml write — never terminal injection, never busy-gated. */
  runPickup(step: FlowStepDef, inputs: Record<string, string>): void;
  /** §26 D42a (resume --loop) — entering a loop step with NO `bootstrap: pickup` RESUMES the existing run
   *  under the step's bound loop: rebind state.yaml to the new loop (fresh internal state, carried
   *  PR/branch/issues) + inject /clear + the first work prompt. Out-of-band like pickup, never busy-gated. */
  resumeLoop(step: FlowStepDef): void;
  /** §27.15 — an `app`-namespace loop step binds the §27 engine. Called INSTEAD of the §26 resume/pickup/
   *  inject ports, so entering it starts the §27 work turn (§27.3) and never a §26 run, even on a machine
   *  holding a same-named §26 def (AC10). The §27 engine owns what the entry does (start the work turn, or
   *  no-op when the def fails to resolve — the run-less/failure view is its surface). */
  enterAppLoop(step: FlowStepDef): void;
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
    const resolved = (name: string): string => {
      if (!Object.prototype.hasOwnProperty.call(inputs, name)) return '';
      const v = inputs[name];
      return typeof v === 'string' ? v.trim() : '';
    };
    const required = (step.inputs ?? []).filter((i) => i.required);
    const missing = required.filter((i) => resolved(i.name) === '');
    // §27.15 — an `app`-namespace loop step is the §27 engine's; the dispatcher routes it to the §27 entry
    // BEFORE any §26 skill/pickup/resume can fire, so the two engines never both run for one step (AC10).
    if (step.kind === 'loop' && step.loopNamespace === APP_LOOP_NAMESPACE) {
      if (missing.length > 0) {
        return { prompt: { inputs: missing.map(({ name, type }) => ({ name, type })), bootstrap: BOOTSTRAP_PICKUP } };
      }
      deps.enterAppLoop(step);
      return {};
    }
    // OWN property only: a prototype-chain key (e.g. an input named `__proto__`) must not resolve to a
    // truthy object. A blank/whitespace value counts as unsatisfied (§18.4).
    if (step.skill) {
      if (deps.isShellBusy()) return { notice: BUSY_NOTICE };
      deps.inject(skillInvocation(step.skill));
    }
    if (step.bootstrap === 'pickup') {
      if (missing.length > 0) {
        return { prompt: { inputs: missing.map(({ name, type }) => ({ name, type })), bootstrap: BOOTSTRAP_PICKUP } };
      }
      // §26.9: in-app pickup is out-of-band gh/git; it runs regardless of the shell being busy. Forward
      // the trimmed required inputs so the runner can resolve the github-ticket issue number.
      const resolvedInputs: Record<string, string> = {};
      for (const i of required) resolvedInputs[i.name] = resolved(i.name);
      deps.runPickup(step, resolvedInputs);
      return {};
    }
    // §26 D42a — a loop step that does NOT bootstrap a fresh run RESUMES the existing one under its bound
    // loop (rebind + /clear + first work prompt). Out-of-band like pickup, so the busy shell never gates it.
    if (step.kind === 'loop') {
      deps.resumeLoop(step);
    }
    return {};
  };
}
