// Imperative side of the app-internal gate transition (§26.6 / L5 / D52). `decideGateOutcome`
// (gateActions.ts) is the pure decision; this carries it out through injected DOMAIN ports — write the
// state.yaml transition, run the gh side-effects out of band (best-effort, §26.11), append the human
// note, and re-iterate (request-changes) or stop (terminal). The orchestrator (index.ts) wires the real
// ports; tests wire fakes and assert the writes/gh op/re-iterate — the observable contract.

import type { GateOutcome } from './gateActions';
import type { GateGitHub } from './gateGithub';
import type { LoopStateWrite } from './loopStateWriter';

/** The run context a gate transition writes from — the current loop state + the human's note text. */
export interface GateExecContext {
  repoDir: string;
  boundLoop: string;
  iteration: number;
  pr: number | null;
  branch: string | null;
  linkedIssues: number[];
  note: string;
}

export interface GateExecDeps {
  github: GateGitHub;
  writeState(state: LoopStateWrite): void;
  writeHumanNote(iteration: number, text: string): void;
  /** request-changes routes back to a fresh work turn at `nextIteration` (clear context + re-run work). */
  reiterate(nextIteration: number): void;
}

/** Carry out a decided gate transition. gh side-effects are best-effort — a failure must never abort the
 *  state write (§26.11; the def's `on_failure: continue`). */
export async function executeGateOutcome(
  outcome: GateOutcome,
  ctx: GateExecContext,
  deps: GateExecDeps,
): Promise<void> {
  const has = (kind: GateOutcome['effects'][number]['kind']): boolean =>
    outcome.effects.some((e) => e.kind === kind);
  const setPhase2 = outcome.effects.find((e) => e.kind === 'set-phase2');
  const nextIteration = outcome.reiterate ? ctx.iteration + 1 : ctx.iteration;

  if (has('mark-pr-ready') && ctx.pr !== null) {
    try {
      await deps.github.markPrReady(ctx.pr);
    } catch {
      /* best-effort (§26.11): a gh failure is reconciled out of band, never blocks the transition */
    }
  }

  // The note keys to the iteration being critiqued (the engine's `{iter}`); the next work turn injects it.
  if (has('append-human-note') && ctx.note.trim().length > 0) deps.writeHumanNote(ctx.iteration, ctx.note);

  deps.writeState({
    status: outcome.nextStatus,
    iteration: nextIteration,
    pr: ctx.pr,
    branch: ctx.branch,
    boundLoop: ctx.boundLoop,
    linkedIssues: ctx.linkedIssues,
    ...(setPhase2 ? { phase2Active: setPhase2.active } : {}),
    ...(has('clear-persona-state') ? { clearPersonaState: true } : {}),
    ...(outcome.terminate ? { terminated: true } : {}),
  });

  if (outcome.reiterate) deps.reiterate(nextIteration);
}
