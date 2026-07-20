// The §27 human-gate decision executor (§27.9/§27.13 / N5) — the app-namespace counterpart of the §26
// `runGateDecision`, kept a SIBLING that never reaches the §26 executor, writes no §26 loop state, and
// injects no §26 actor (AC8). It acts only on the step+turn identity the decision names, reconstructed from
// the persisted §27 run-state (which survives a relaunch, AC10) — never ambient state (AC7). The option is
// validated against the bound def's declared gate options AT THE OPERATION (AC9): a legacy-bound step can
// never reach this path (a different channel), and a §27 step can only run an option its def declares.
//
// Approve (this slice) runs the loop's declared side-effect data-driven from the bound def as an out-of-band
// best-effort GitHub call, then reaches the terminal accept and advances the flow. A failed side-effect is
// surfaced + audited but never aborts the accept and never strands the step (§27.13 / AC3). request-changes /
// redo / polish are declared by later slices' defs; until then an undeclared option is inert here.

import type { GateDecisionOption } from '../shared/ipc';
import type { AppLoopRunState } from './appLoopState';
import type { LoopDefV2, LoopDefV2Result } from './loopDefV2';
import type { RunAppGateSideEffect } from './appGateGithub';

/** The refs (§24.2.3 T7) an approve side-effect acts on, resolved from the flow view — a §27 step sources
 *  these only from the flow's typed inputs, never a §26 state.yaml (§27.15). */
export interface AppGateRefs {
  pr: number | null;
  ticket: number | null;
}

/** The seam the executor needs, each a domain concept (not a mechanism): read the persisted §27 gate state,
 *  resolve the bound def, resolve the flow refs + the body-artifact the loop declares, run a declared
 *  side-effect, persist the terminal accept, advance the flow, audit, and surface a failure. Injected so the
 *  decision logic is driven with fakes (no PTY), while the real wiring lives in the composition root. */
export interface AppGateDecisionDeps {
  readRunState(repoDir: string): AppLoopRunState | null;
  resolveDef(repoDir: string, loopName: string): LoopDefV2Result;
  refs(repoDir: string): AppGateRefs;
  /** The confined path of the loop's output artifact used as the issue/PR body for a body-publish action, or
   *  null when the loop declares no output. */
  bodyFile(def: LoopDefV2): string | null;
  runSideEffect: RunAppGateSideEffect;
  persistAccept(repoDir: string, state: AppLoopRunState): void;
  advanceFlow(repoDir: string): void;
  audit(repoDir: string, cmd: string, exit: number | null): void;
  emitError(reason: string): void;
  onViewChanged(): void;
}

/** Execute a §27 human-gate decision for the step+turn identity it names. Inert (no state change, no advance)
 *  unless the persisted gate matches that identity, is AT the gate (a verdict reached), and the option is one
 *  the bound def declares. Sub-ticket 1 implements `approve`; other declared options land with their slices. */
export async function runAppGateDecision(
  _repoDir: string,
  _step: string,
  _turnKey: string,
  _option: GateDecisionOption,
  _deps: AppGateDecisionDeps,
): Promise<void> {
  // TODO(N5): validate the identity + option, run the declared side-effect, persist the accept, advance.
}
