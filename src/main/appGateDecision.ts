// The §27 human-gate decision executor (§27.9/§27.13 / N5) — a SIBLING of the §26 `runGateDecision`: it must
// never reach the §26 executor, write §26 loop state, or inject a §26 actor (AC8/§27.15).

import type { GateDecisionOption } from '../shared/ipc';
import { gateDecisionAuditCmd } from '../shared/audit';
import {
  validFeedback,
  validInstruction,
  type AppLoopBootstrap,
  type AppLoopRunState,
} from './appLoopState';
import type { LoopDefV2, LoopDefV2Result } from './loopDefV2';
import type { AppGateSideEffectCtx, RunAppGateSideEffect } from './appGateGithub';

/** The refs (§24.2.3 T7) an approve side-effect acts on, resolved from the flow view — a §27 step sources
 *  these only from the flow's typed inputs, never a §26 state.yaml (§27.15). */
export interface AppGateRefs {
  pr: number | null;
  ticket: number | null;
  bootstrap: AppLoopBootstrap | null;
}

export function resolveAppGateRefs(
  flow: { pr?: number; ticket?: number } | undefined,
  bootstrap: AppLoopBootstrap | null,
): AppGateRefs {
  const ticket = flow?.ticket ?? bootstrap?.issue ?? null;
  const usesBootstrap =
    flow?.pr === undefined &&
    bootstrap !== null &&
    bootstrap.issue === ticket;
  return {
    pr: flow?.pr ?? (usesBootstrap ? bootstrap.pr : null),
    ticket,
    bootstrap: usesBootstrap ? bootstrap : null,
  };
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
  /** §27.9/§19.4 (AC4) — request-changes re-enters the review-and-fix round carrying the operator's feedback
   *  (a domain port the composition root wires to the §27 engine). It is NOT approve: the flow does not
   *  advance and no gh side-effect runs — the loop returns to iterate on the step. Returns whether the round
   *  was actually started: `false` means the engine dropped it (runner mid-turn, or the gate raced out), which
   *  runAppGateDecision returns to its caller so the still-open composer keeps the feedback for a retry. */
  deliverFeedback(repoDir: string, step: string, turnKey: string, feedback: string): boolean;
  /** §27.9/AC5 — redo re-enters the WORK turn on a clean slate carrying the operator's instruction (a domain
   *  port the composition root wires to the §27 engine). Like deliverFeedback it is NOT approve: the flow does
   *  not advance and no gh side-effect runs. Returns whether the work turn re-entered — `false` means the engine
   *  dropped it (runner mid-turn, gate raced out, or a polish stand-down), which the two-way caller returns so
   *  the still-open redo composer keeps the instruction for a retry. */
  deliverRedo(repoDir: string, step: string, turnKey: string, instruction: string): boolean;
  /** §27.9/AC6 — enter the polish stand-down for `step`: the orchestrator stops injecting and the operator
   *  takes the keyboard. App-owned loop state only (never the §26 surface); persisted so it survives a relaunch.
   *  Throws only when the loop area is unresolvable (a planted symlink) — the caller keeps that off the flow. */
  enterPolish(repoDir: string, step: string): void;
  /** §27.9/AC6 — end the polish stand-down. Approve is the one lever that clears it (best-effort; an absent
   *  stand-down is already the cleared state). */
  clearPolish(repoDir: string): void;
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
  note?: string,
): Promise<boolean> {
  const run = deps.readRunState(repoDir);
  // §6/AC7
  if (!run || run.step !== step || run.turnKey !== turnKey) return false;
  if (run.status !== 'complete' || run.verdict === undefined) return false;

  const r = deps.resolveDef(repoDir, run.loop);
  if (!r.ok) return false;
  // AC9
  const gateOpt = r.def.gate.find((g) => g.option === option);
  if (!gateOpt) return false;

  // §27.9/§19.4 (AC4) — request-changes is not approve: a blank note fires no round, and the delivered/dropped
  // result is RETURNED so the two-way caller (the feedback composer) holds open and keeps the human's feedback
  // on a drop rather than losing it. A drop is audited (never a false-success exit 0); the caller surfaces it.
  if (option === 'request-changes') {
    const feedback = validFeedback(note);
    if (feedback === undefined) return false;
    if (deps.deliverFeedback(repoDir, step, turnKey, feedback)) {
      deps.audit(repoDir, gateDecisionAuditCmd('decision', option), 0);
      return true;
    }
    deps.audit(repoDir, gateDecisionAuditCmd('decision-dropped', option, 'the loop was busy'), 1);
    return false;
  }
  // §27.9/AC5 — redo is request-changes' clean-slate twin: the note carries the human's instruction, the
  // delivered/dropped result is RETURNED so the two-way caller (the redo composer) holds open and keeps the
  // instruction on a drop, and a blank note fires nothing.
  if (option === 'redo') {
    const instruction = validInstruction(note);
    if (instruction === undefined) return false;
    if (deps.deliverRedo(repoDir, step, turnKey, instruction)) {
      deps.audit(repoDir, gateDecisionAuditCmd('decision', option), 0);
      return true;
    }
    deps.audit(repoDir, gateDecisionAuditCmd('decision-dropped', option, 'the loop was busy'), 1);
    return false;
  }
  // §27.9/AC6 — polish stands the orchestrator down: write app-owned loop state only (never the §26 surface).
  // Best-effort — an unresolvable loop area (a planted symlink) must not crash the decision path; it is surfaced
  // and the operator can retry. One-way (no human input to lose), so the result is ignored by the caller.
  if (option === 'polish') {
    try {
      deps.enterPolish(repoDir, step);
      deps.audit(repoDir, gateDecisionAuditCmd('decision', option), 0);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      deps.emitError(`could not enter polish: ${reason}`);
    }
    deps.onViewChanged();
    return false;
  }
  // impasse (§26-only) is never executed here.
  if (option !== 'approve') return false;

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
    return false;
  }
  // §27.9/AC6 — approve ends any polish stand-down. Cleared ONLY after the accept persisted (above), so a failed
  // accept leaves the operator still in polish and able to retry rather than stranded out of it. Best-effort: the
  // accept has already persisted, so a throw here (e.g. the polish file swapped for a directory → EISDIR, which
  // rmSync's `force` does not swallow) must NOT abort the approve — the residual file is harmless once the gate is
  // accepted (post-accept the gate view never renders). Recorded, never swallowed; never surfaced as a blocking
  // dialog (the accept succeeded, so alarming the operator over cosmetic cleanup would be the wrong signal).
  try {
    deps.clearPolish(repoDir);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    deps.audit(repoDir, gateDecisionAuditCmd('clear-polish-failed', option, reason), 1);
  }
  deps.onViewChanged();

  // §27.13/AC3
  const refs = deps.refs(repoDir);
  const bodyFile = deps.bodyFile(r.def);
  const ctx: AppGateSideEffectCtx = {
    pr: refs.pr,
    ticket: refs.ticket,
    bodyFile,
    bootstrap: refs.bootstrap,
  };
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
  return false; // only a request-changes reports true; approve's result is ignored by the one-way caller
}
