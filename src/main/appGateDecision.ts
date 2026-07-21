// The §27 human-gate decision executor (§27.9/§27.13 / N5) — a SIBLING of the §26 `runGateDecision`: it must
// never reach the §26 executor, write §26 loop state, or inject a §26 actor (AC8/§27.15).

import type { GateDecisionOption } from '../shared/ipc';
import { gateDecisionAuditCmd } from '../shared/audit';
import type { AppLoopRunState } from './appLoopState';
import type { LoopDefV2, LoopDefV2Result } from './loopDefV2';
import type { AppGateSideEffectCtx, RunAppGateSideEffect } from './appGateGithub';

/** The refs (§24.2.3 T7) an approve side-effect acts on, resolved from the flow view — a §27 step sources
 *  these only from the flow's typed inputs, never a §26 state.yaml (§27.15). */
export interface AppGateRefs {
  pr: number | null;
  ticket: number | null;
}

/** The executor's injection seam — each member a domain concept, not a mechanism (CODE-STANDARDS seam rule),
 *  so the decision logic runs under fakes with no PTY while the composition root wires the real ports. */
export interface AppGateDecisionDeps {
  readRunState(repoDir: string): AppLoopRunState | null;
  resolveDef(repoDir: string, loopName: string): LoopDefV2Result;
  refs(repoDir: string): AppGateRefs;
  /** The confined path (CWE-22) of the loop's completion artifact, published as the issue/PR body; null when no
   *  declared output backs the loop's `work.artifact` id. */
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
 *  the bound def declares. */
export async function runAppGateDecision(
  repoDir: string,
  step: string,
  turnKey: string,
  option: GateDecisionOption,
  deps: AppGateDecisionDeps,
): Promise<void> {
  const run = deps.readRunState(repoDir);
  // §6/AC7
  if (!run || run.step !== step || run.turnKey !== turnKey) return;
  if (run.status !== 'complete' || run.verdict === undefined) return;

  const r = deps.resolveDef(repoDir, run.loop);
  if (!r.ok) return;
  // AC9
  const gateOpt = r.def.gate.find((g) => g.option === option);
  if (!gateOpt) return;
  if (option !== 'approve') return;

  // §26 D48 — a failed accept persist aborts the decision (a relaunch would otherwise reconstruct the gate and
  // re-run the outward side-effect); a failed side-effect does not (§27.13 / AC3).
  const accepted: AppLoopRunState = { loop: run.loop, step: run.step, turnKey: run.turnKey, status: 'accepted' };
  try {
    deps.persistAccept(repoDir, accepted);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    deps.audit(repoDir, gateDecisionAuditCmd('accept-failed', option, reason), 1);
    deps.emitError(`could not persist gate accept: ${reason}`);
    deps.onViewChanged();
    return;
  }
  deps.onViewChanged();

  // §27.13/AC3
  const refs = deps.refs(repoDir);
  const bodyFile = deps.bodyFile(r.def);
  const ctx: AppGateSideEffectCtx = { pr: refs.pr, ticket: refs.ticket, bodyFile };
  for (const se of gateOpt.sideEffects) {
    if (se.kind !== 'gh') continue;
    const action = typeof se.args.action === 'string' ? se.args.action : '';
    try {
      await deps.runSideEffect(action, ctx);
      deps.audit(repoDir, gateDecisionAuditCmd('side-effect', option, action), 0);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      deps.audit(repoDir, gateDecisionAuditCmd('side-effect-failed', option, `${action}: ${reason}`), 1);
      deps.emitError(`approve side-effect failed: ${reason}`);
    }
  }

  deps.audit(repoDir, gateDecisionAuditCmd('decision', option), 0);
  deps.advanceFlow(repoDir);
  deps.onViewChanged();
}
