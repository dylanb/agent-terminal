// Imperative side of the app-internal gate transition (§26.6 / L5 / D52). `decideGateOutcome`
// (gateActions.ts) is the pure decision; this carries it out through injected DOMAIN ports — write the
// state.yaml transition, run the gh side-effects out of band (best-effort, §26.11), append the human
// note, and re-iterate (request-changes) or stop (terminal). The orchestrator (index.ts) wires the real
// ports; tests wire fakes and assert the writes/gh op/re-iterate — the observable contract.

import type { GateOutcome } from './gateActions';
import type { GateGitHub } from './gateGithub';
import type { LoopStateWrite } from './loopStateWriter';
import type { EpicPlan } from './epicPlan';
import { interpolateExecArgv, type RunGateExec } from './gateExec';
import { errMsg } from './errno';

/** The run context a gate transition writes from — the current loop state + the human's note text. */
export interface GateExecContext {
  repoDir: string;
  boundLoop: string;
  iteration: number;
  pr: number | null;
  branch: string | null;
  linkedIssues: number[];
  note: string;
  /** §26.9 — whether this run's epic was ALREADY promoted (state.yaml `epic.sub_issues` non-empty). Guards
   *  the irreversible `gh issue create` fan-out so a re-entered gate never creates duplicate sub-issues. */
  epicAlreadyPromoted: boolean;
  /** §26.6 — whether the `exec` gate action may run for this loop (allowed by default; the repo opts a loop
   *  out via `.agent-loop.yaml` `loops_deny_exec`). False skips every exec effect. */
  execAllowed: boolean;
}

export interface GateExecDeps {
  github: GateGitHub;
  writeState(state: LoopStateWrite): void;
  writeHumanNote(iteration: number, text: string): void;
  /** request-changes routes back to a fresh work turn at `nextIteration` (clear context + re-run work). */
  reiterate(nextIteration: number): void;
  /** §26.9 / L8 — the epic classification of the current plan (from plan.md). Consulted only when the
   *  gate carries an `epic-promote` effect; its `isEpic` is the action's `when` guard. */
  readEpicPlan(): EpicPlan;
  /** §26.6/D48 — the gate transition could NOT be persisted (the state.yaml write threw). The executor
   *  leaves the loop where it is and never re-iterates, but the failure must not be silent: the host
   *  surfaces `reason` (error dialog + audit) so the loop can never sit stranded with no trace. */
  onWriteFailed(reason: string): void;
  /** §26.6 — resolve an `exec` action's `{{artifact.<id>}}` to a path (from the bound LoopDef), or null. */
  resolveArtifact(id: string): string | null;
  /** §26.6 — run a fully-resolved `exec` argv out of band (execFile, best-effort). */
  runExec: RunGateExec;
}

/** Run epic-promote (§26.9): the current PR IS sub-ticket-1, so create the REMAINING N-1 sub-issues out
 *  of band and return the numbers that landed. Best-effort — a failed create is skipped, never aborts the
 *  gate transition. A non-epic plan (the `when` guard) creates nothing. */
async function promoteEpic(github: GateGitHub, plan: EpicPlan): Promise<number[]> {
  if (!plan.isEpic) return [];
  const created: number[] = [];
  for (const ticket of plan.subTickets.slice(1)) {
    try {
      const n = await github.createSubIssue({ title: ticket.title, body: ticket.body });
      if (n !== null) created.push(n);
    } catch {
      /* best-effort (§26.9): a sub-issue create failure is reconciled out of band, never blocks */
    }
  }
  return created;
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
  const nextIteration = outcome.reiterate ? ctx.iteration + 1 : ctx.iteration;

  // §26.9 / L8 — epic-promote runs BEFORE the state write so its new sub-issues land in the same doc
  // (appended to linked_issues + recorded under `epic`). Best-effort; a non-epic plan yields []. Skipped
  // when the epic was already promoted (idempotent — `gh issue create` is irreversible, so a re-entered
  // gate must not duplicate the sub-issues).
  const subIssues =
    has('epic-promote') && !ctx.epicAlreadyPromoted ? await promoteEpic(deps.github, deps.readEpicPlan()) : [];

  if (has('mark-pr-ready') && ctx.pr !== null) {
    try {
      await deps.github.markPrReady(ctx.pr);
    } catch {
      /* best-effort (§26.11): a gh failure is reconciled out of band, never blocks the transition */
    }
  }

  // §26.6 — exec adapter side-effects (e.g. ticket-body publish). Skipped entirely when the loop is opted
  // out (execAllowed). Each argv is interpolated against the run; an argv that does not fully resolve is
  // skipped (never run a half-filled command). Best-effort — a run failure is reconciled out of band.
  if (ctx.execAllowed) {
    for (const e of outcome.effects) {
      if (e.kind !== 'exec') continue;
      const argv = interpolateExecArgv(e.argv, { linkedIssues: ctx.linkedIssues, resolveArtifact: deps.resolveArtifact });
      if (argv === null) continue;
      try {
        await deps.runExec(argv);
      } catch {
        /* best-effort (§26.11): a failed exec is reconciled out of band, never blocks the transition */
      }
    }
  }

  // The note keys to the iteration being critiqued (the engine's `{iter}`); the next work turn injects it.
  if (has('append-human-note') && ctx.note.trim().length > 0) deps.writeHumanNote(ctx.iteration, ctx.note);

  try {
    deps.writeState({
      status: outcome.nextStatus,
      iteration: nextIteration,
      pr: ctx.pr,
      branch: ctx.branch,
      boundLoop: ctx.boundLoop,
      linkedIssues: [...ctx.linkedIssues, ...subIssues],
      // §26.6/§26.8 — cap_baseline = the critiqued iteration makes the next round internal-count 1
      // (`iteration - cap_baseline`), reopening the autonomous window that request-changes just reset.
      ...(has('reset-cap') ? { capBaseline: ctx.iteration } : {}),
      ...(has('clear-persona-state') ? { clearPersonaState: true } : {}),
      ...(subIssues.length > 0 ? { epic: { subIssues } } : {}),
      ...(outcome.terminate ? { terminated: true } : {}),
    });
  } catch (e) {
    // A failed state write leaves the loop where it is — never re-iterate against unpersisted state, and
    // never surface as an unhandled rejection in main (the `void` call site cannot catch it, §26.11). But
    // it must not be SILENT (§26.6/D48): report it so the host raises the error dialog + records the audit,
    // otherwise the loop sits stranded with no trace.
    deps.onWriteFailed(errMsg(e));
    return;
  }

  if (outcome.reiterate) deps.reiterate(nextIteration);
}
