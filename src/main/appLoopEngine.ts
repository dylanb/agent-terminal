// The §27 (app-namespace) loop engine — the WRITE half of the coexistence seam (§27.15). On entry to an
// `app` flow step it runs the def's declared context boundary, injects the composed work prompt once through
// the §9.3 injector when injectable (§27.2), and gates the work turn's completion on the turn-keyed done-file
// plus (for a def that declares one) a well-formed completion artifact. On work completion it chains the
// REVIEW-AND-FIX turn (§27.3): cross the def-declared pre-review boundary, inject the review prompt, and gate
// that turn on the done-file plus a well-formed round report (full-roster accounting, §27.5/§27.12) — never a
// quality judgment. Either turn retries once then stops in `error`, and run state persists to the app-owned
// §27 loop-state file so a relaunch reconstructs the stopped turn and never re-drives a completed one
// (§27.10/§27.12). The `error` route-out (retry / accept / terminate) acts on the step+turn identity it is
// handed, never ambient state (§6); the review-turn accept diverges from the work-turn accept as an override
// of the well-formedness gate (§27.12c/AC8).
//
// The in-flight turn STATE MACHINE — inject-when-injectable, the boundary preamble drain, retry-once, the
// stall watchdog — is reused read-only from the §26 turn runner (loopOrchestrator.ts, the plan's authorized
// "read-only §26-cited copy"); this module owns only the §27-specific run state, the artifact-marker gate,
// and the route-out. Every effect is a domain port the host wires to the injector, the §8.3 quiescence
// signal, the stall timer, the §27 loop-state writer, and the flow — never the primitives behind them.

import path from 'node:path';
import { createTurnRunner, type HostedAgentState, type TurnRunner } from './loopOrchestrator';
import type { LoopDefV2, LoopDefV2Result } from './loopDefV2';
import { artifactWellFormed, boundaryCommand, completionArtifact, completionMarker, composeAppWorkPrompt } from './appWorkTurn';
import { catalogPersonas, composeReviewAndFixPrompt, preReviewBoundaryCommand, reviewRoster, type RosterEntry } from './reviewTurn';
import { composeConsolidatePrompt, lastTwoReportRounds, preConsolidateBoundaryCommand } from './consolidateTurn';
import { clearTurnDone } from './turnDoneFile';
import { TURN_DONE_FILENAME } from '../shared/loopTurn';
import { failedReviewers, roundReportWellFormed } from '../shared/roundReport';
import { consolidatorOutputWellFormed, parseConsolidatorOutput, verdictCarriesReason, type ConsolidatorVerdict } from '../shared/consolidatorOutput';
import { consolidateAuditCmd, reviewRoundAuditCmd } from '../shared/audit';
import { APP_LOOP_DIR_SEGMENTS, clearInterrupt, readAppLoopState, readArmedInterrupt, type AppLoopRunState } from './appLoopState';

/** The §27 done-file lives in the §27 loop area, disjoint from §26's `.agent-loop/` (AC10 separation). */
const APP_TURN_DONE_SUBDIR = path.join(...APP_LOOP_DIR_SEGMENTS);
const APP_DONE_REL_PATH = APP_LOOP_DIR_SEGMENTS.join('/') + '/' + TURN_DONE_FILENAME;

const WORK_TURN_PREFIX = 'work-';
const REVIEW_TURN_PREFIX = 'review-';
const CONSOLIDATE_TURN_PREFIX = 'consolidate-';
/** The first review-and-fix round; the consolidator's `another round` verdict advances it (§27.6). */
const FIRST_ROUND = 1;
/** The route-out reason a relaunch gives a turn the persisted state left mid-flight (`working`): its PTY is
 *  gone and resume never re-drives it, so it is stopped and the human must retry/terminate it (§27.12/CWE-703). */
const RELAUNCH_INTERRUPTED_REASON = 'the turn was interrupted before it could finish — retry or terminate';

export type AppRouteOut = 'retry' | 'accept' | 'terminate';

/** Why the §27 work turn holds a live error, as a structured discriminator so a consumer branches on the
 *  kind rather than the human-facing `reason` prose: `turn-error` is a stall/completion-gate failure of the
 *  turn itself; `def-unresolvable` is an Accept refused because the resumed turn's def no longer resolves
 *  (§27.12c/CWE-755). The `reason` wording is free to change without moving any consumer. */
export type AppLoopErrorKind = 'turn-error' | 'def-unresolvable';

/** The live in-memory error of the §27 work turn, surfaced to the view when the persisted error write
 *  failed (ENOSPC/EPERM/a planted symlink) so the route-out is never a dead-end (§27.12c). */
export interface AppLoopLiveError {
  kind: AppLoopErrorKind;
  loop: string;
  step: string;
  turnKey: string;
  reason: string;
  /** The review-and-fix round this error belongs to, so the view carries the round number onto the
   *  route-out surface; absent for a work-turn error (no round has run). */
  round?: number;
}

/** The completion contract of the work turn, as a discriminated union so no mode carries a field another
 *  ignores: a file-producing turn gates on its artifact, a commit-producing turn on the done-signal alone,
 *  and an `unresolved` turn (resume could not re-resolve the def) can never be accepted — Accept must read a
 *  true artifact, never fabricate a pass (CWE-754). */
type AppCompletion =
  | { kind: 'file'; path: string; marker: string; artifactRel: string }
  | { kind: 'commits' }
  | { kind: 'unresolved' };

export interface AppLoopEngineDeps {
  /** Inject + submit `text` into the hosted instance (§9.3). */
  inject(text: string): void;
  /** §27.9/AC6 — whether the polish stand-down is active for the repo: the operator has taken the keyboard and
   *  the orchestrator must inject nothing until approve ends it. The engine consults this before running any
   *  lever that would re-enter a turn (redo, request-changes), so a decision racing the stand-down never
   *  restarts the orchestrator. A domain predicate, not the app-loop-state file shape behind it. */
  polishActive(repoDir: string): boolean;
  /** The hosted instance's injection-readiness (§27.2) — idle / busy / absent. */
  hostedAgent(): HostedAgentState;
  /** Arm / cancel the stall watchdog (§27.12) — reset on visible activity, no wall-clock deadline. */
  armTimer(): void;
  cancelTimer(): void;
  /** §27.2 — re-arm the quiescence window so a chained turn waits for a fresh settle before injecting. */
  noteSettle(): void;
  /** Resolve the bound §27 def for a repo (§27.8); its reason surfaces at the view on failure (AC6). The
   *  repoDir is the tier context's repo root — the tier roots themselves are chosen by the parsed namespace,
   *  never derived from repo content. */
  resolveDef(repoDir: string, loopName: string): LoopDefV2Result;
  /** Read the def's confined work-recipe body; null on read failure (an unrecoverable config error). */
  readRecipe(absPath: string): string | null;
  /** Read the confined completion-artifact content; null when absent/unreadable (the domain concept, not
   *  an fs shape — the fs read is the host's). */
  readArtifact(absPath: string): string | null;
  /** Persist the §27 run state (§27.10). */
  persist(repoDir: string, state: AppLoopRunState): void;
  /** Record a §25 audit event for the turn (best-effort; never aborts the turn). */
  audit(repoDir: string, cmd: string, exit: number | null): void;
  /** §27-only error push so the renderer surfaces the reason (never a silent stop, §26.3/D48 parallel). */
  emitError(reason: string): void;
  /** The live loop view changed — the panel/strip re-pull. */
  onViewChanged(): void;
  /** Move the flow off the step (§27.9 abandon = flow Terminate) for the terminate route-out. */
  terminateFlow(repoDir: string): void;
  /** Resolve round N's report location (§27.5) — the confined absolute path the engine reads and the
   *  repo-relative path the fixer writes, from ONE resolver; null when the loop area is unresolvable. */
  resolveReportLocation(repoDir: string, round: number): { abs: string; rel: string } | null;
  /** Resolve round N's consolidator-output location (§27.6) — the confined absolute path the engine reads
   *  back to gate the turn and the repo-relative path the consolidator writes, from ONE resolver; null when
   *  the loop area is unresolvable. */
  resolveConsolidatorLocation(repoDir: string, round: number): { abs: string; rel: string } | null;
}

export interface AppLoopEngine {
  /** Enter an `app` step: resolve the def, run the boundary, inject the work prompt once when injectable.
   *  A no-op (leaving the resolve-time failure view, AC6) when the def does not resolve. */
  enter(repoDir: string, loopName: string, stepId: string): void;
  /** The instance may have become injectable (a §8.3 quiet flip) — re-evaluate a pending/retry turn. */
  onInjectable(): void;
  /** The turn's done-file fired (host-watched, key-matched) — gate completion (§27.12). */
  onDoneSignal(): void;
  /** A §8.3 visible-content edge — reset the in-flight turn's stall watchdog. */
  noteActivity(): void;
  /** The stall watchdog elapsed — resolve to `error` without retrying or killing (§27.12). */
  onStall(): void;
  /** The §27-only error route-out, acting on the payload's step+turn identity, never ambient state (§6). */
  routeOut(repoDir: string, stepId: string, turnKey: string, action: AppRouteOut): void;
  /** §27.9/§19.4 (AC4) — a request-changes gate decision: re-enter the review-and-fix turn at round+1
   *  carrying the operator's `feedback` alongside the reviewers' findings, over the def's full catalog (fresh
   *  eyes). Acts only on the persisted gate matching the step+turn identity it names (§6), and only when that
   *  run is AT a gate (a reached verdict); otherwise inert. Never runs the consolidator or the work turn.
   *  Returns whether the round was started — `false` on every inert case so the caller can surface a drop. */
  requestChanges(repoDir: string, stepId: string, turnKey: string, feedback: string): boolean;
  /** §27.9/AC5 — a redo gate decision: re-enter the WORK turn on a clean slate (after its entry boundary),
   *  carrying ONLY the ticket, the plan, and the operator's `instruction` — no findings, no round history. The
   *  only lever that re-runs the work turn. Acts only on the persisted gate matching the step+turn identity it
   *  names (§6), only when that run is AT a gate (a reached verdict), and never while polish stands the
   *  orchestrator down (AC6). Returns whether the work turn re-entered — `false` on every inert case so the
   *  caller (the redo composer) can surface a drop and keep the human's instruction. */
  redo(repoDir: string, stepId: string, turnKey: string, instruction: string): boolean;
  /** On launch: reconstruct a stopped turn from the persisted run state; an `error`/`complete` turn is
   *  human-owned and never re-driven, only made routable (§27.12). */
  resume(repoDir: string): void;
  /** The active turn's key, for the host's done-file watcher key-match; null when idle. */
  activeTurnKey(): string | null;
  /** The active turn's repo dir, for the host's signal routing; null when idle. */
  activeRepoDir(): string | null;
  /** The live in-memory error for `repoDir`, or null — the view surfaces it when the persisted error write
   *  failed, so the route-out stays reachable (§27.12c). */
  liveErrorFor(repoDir: string): AppLoopLiveError | null;
}

/** The in-flight §27 turn, a discriminated union on `phase` so the work turn and the chained review-and-fix
 *  turn each carry only what they need (§27.3). Both share the ids the route-out and persistence key on. */
type ActiveAppTurn =
  | {
      phase: 'work';
      repoDir: string;
      loopName: string;
      stepId: string;
      turnKey: string;
      boundaryCmd: string;
      recipePath: string;
      completion: AppCompletion;
      /** §27.9/AC5 — the operator's redo instruction carried into this work turn, threaded into the work
       *  prompt as the clean-slate directive; absent on an ordinary (non-redo) work run. Persisted so a
       *  relaunch or Retry re-injects it rather than dropping the human's input (mirrors review `feedback`). */
      instruction?: string;
    }
  | {
      phase: 'review';
      repoDir: string;
      loopName: string;
      stepId: string;
      turnKey: string;
      boundaryCmd: string;
      round: number;
      reviewers: RosterEntry[];
      sections: string[];
      reportPath: string;
      reportRel: string;
      completion: { kind: 'report' } | { kind: 'unresolved' };
      /** The roster the consolidator chose for this round (§27.6/AC8); absent on round 1 (the full catalog). */
      chosenRoster?: string[];
      /** §27.9/AC4 — the operator's request-changes feedback carried into this round, threaded into the
       *  review prompt alongside the reviewers' findings; absent on a consolidator-driven another-round. */
      feedback?: string;
    }
  | {
      phase: 'consolidate';
      repoDir: string;
      loopName: string;
      stepId: string;
      turnKey: string;
      boundaryCmd: string;
      round: number;
      /** The def's reviewer catalog personas — the set the chosen roster is validated against (§27.4). */
      catalog: string[];
      recipePath: string;
      outputPath: string;
      outputRel: string;
      /** The last-two round reports (this round + the previous, §27.6/AC2), by repo-relative and absolute path. */
      reportRels: string[];
      reportPaths: string[];
      completion: { kind: 'output' } | { kind: 'unresolved' };
      /** The verdict / reason / roster the consolidator reached, set when it routes to the gate (§27.6). */
      verdict?: ConsolidatorVerdict;
      verdictReason?: string;
      chosenRoster?: string[];
    };

/** The entry context boundary before WORK (§27.3): the def's first declared boundary, defaulting to
 *  `clear` when the def names none (every turn boundary is clear-or-compact, §27.7). */
function entryBoundaryCommand(def: LoopDefV2): string {
  const first = def.boundaries[0];
  return first ? boundaryCommand(first) : '/clear';
}

/** The review arm of an in-flight turn whose def/report-location no longer resolves (§27.12c): no roster, no
 *  report, `completion.kind === 'unresolved'` so Accept refuses it. Seeded identically by `startReview`'s
 *  fallback and `resume`'s fallback so the shape lives in one place. */
function unresolvedReviewTurn(args: { repoDir: string; loopName: string; stepId: string; turnKey: string; round: number }): Extract<ActiveAppTurn, { phase: 'review' }> {
  return {
    phase: 'review',
    repoDir: args.repoDir,
    loopName: args.loopName,
    stepId: args.stepId,
    turnKey: args.turnKey,
    boundaryCmd: '/clear',
    round: args.round,
    reviewers: [],
    sections: [],
    reportPath: '',
    reportRel: '',
    completion: { kind: 'unresolved' },
  };
}

/** The reconstructable identity a chained turn is built for — the bound loop, its flow step, and the repo. */
interface TurnCtx {
  repoDir: string;
  loopName: string;
  stepId: string;
}

/** The consolidator arm of an in-flight turn whose def/report/output location no longer resolves (§27.12c):
 *  no catalog, no reports, `completion.kind === 'unresolved'` so Accept has nothing to finalize. Seeded
 *  identically by `startConsolidate`'s fallback and `resume`'s fallback so the shape lives in one place. */
function unresolvedConsolidateTurn(args: TurnCtx & { turnKey: string; round: number }): Extract<ActiveAppTurn, { phase: 'consolidate' }> {
  return {
    phase: 'consolidate',
    repoDir: args.repoDir,
    loopName: args.loopName,
    stepId: args.stepId,
    turnKey: args.turnKey,
    boundaryCmd: '/clear',
    round: args.round,
    catalog: [],
    recipePath: '',
    outputPath: '',
    outputRel: '',
    reportRels: [],
    reportPaths: [],
    completion: { kind: 'unresolved' },
  };
}

/** The §25 audit command for a turn that stopped in `error`, keyed to the phase's vocabulary (§27.12). */
function turnErrorAuditCmd(turn: ActiveAppTurn, reason: string): string {
  if (turn.phase === 'review') return reviewRoundAuditCmd('error', turn.round, reason);
  if (turn.phase === 'consolidate') return consolidateAuditCmd('error', turn.round, reason);
  return `§27 work turn ${turn.turnKey} failed: ${reason}`;
}

function activeTurnFor(repoDir: string, loopName: string, stepId: string, def: LoopDefV2, instruction?: string): ActiveAppTurn {
  const artifact = completionArtifact(def);
  return {
    phase: 'work',
    repoDir,
    loopName,
    stepId,
    turnKey: `${WORK_TURN_PREFIX}${stepId}`,
    recipePath: def.work.recipe,
    boundaryCmd: entryBoundaryCommand(def),
    completion: artifact
      ? { kind: 'file', path: artifact.path, marker: completionMarker(stepId), artifactRel: path.relative(repoDir, artifact.path) }
      : { kind: 'commits' },
    ...(instruction !== undefined ? { instruction } : {}),
  };
}

export function createAppLoopEngine(deps: AppLoopEngineDeps): AppLoopEngine {
  let active: ActiveAppTurn | null = null;
  let runner: TurnRunner;
  // The last errored turn, kept until it transitions out of error, so the view can surface the route-out
  // even when the persisted error write failed (§27.12c). Cleared on every non-error persist.
  let liveError: (AppLoopLiveError & { repoDir: string }) | null = null;

  const persist = (status: AppLoopRunState['status'], errorReason?: string): boolean => {
    if (!active) return false;
    if (status !== 'error') liveError = null;
    const round = active.phase === 'review' || active.phase === 'consolidate' ? active.round : undefined;
    const verdict = active.phase === 'consolidate' ? active.verdict : undefined;
    const verdictReason = active.phase === 'consolidate' ? active.verdictReason : undefined;
    const chosenRoster = active.phase === 'consolidate' || active.phase === 'review' ? active.chosenRoster : undefined;
    // §27.9/AC4 — a review round entered by request-changes carries the operator's feedback; persisted so a
    // relaunch or Retry re-injects it rather than dropping it.
    const feedback = active.phase === 'review' ? active.feedback : undefined;
    // §27.9/AC5 — a work turn entered by redo carries the operator's instruction; persisted for the same reason.
    const instruction = active.phase === 'work' ? active.instruction : undefined;
    let landed = true;
    try {
      deps.persist(active.repoDir, {
        loop: active.loopName,
        step: active.stepId,
        turnKey: active.turnKey,
        status,
        ...(errorReason ? { errorReason } : {}),
        ...(round !== undefined ? { round } : {}),
        ...(verdict !== undefined ? { verdict } : {}),
        ...(verdictReason !== undefined ? { verdictReason } : {}),
        ...(chosenRoster !== undefined ? { chosenRoster } : {}),
        ...(feedback !== undefined ? { feedback } : {}),
        ...(instruction !== undefined ? { instruction } : {}),
      });
    } catch (e) {
      // §27.10 resume state is best-effort: a write failure must never abort the turn's live path or crash
      // main from a timer/watcher callback (CLAUDE.md — a best-effort side effect never aborts its path;
      // CWE-703/755). The caller learns the write did not land so a terminal completion can still hold a live
      // error and summon the human, instead of stranding the disk at a stale `working`.
      void (e instanceof Error ? e.message : String(e));
      landed = false;
    }
    deps.onViewChanged();
    return landed;
  };

  /** Build and hold the live error for the ACTIVE turn's identity — the one place the `AppLoopLiveError`
   *  literal is spelled, so a new field cannot be threaded through one construction site and dropped from
   *  another (§27.12c). Every route-out/persist-failure/resume site that summons the human goes through here. */
  const setLiveError = (kind: AppLoopErrorKind, reason: string, round?: number): void => {
    if (!active) return;
    liveError = { kind, repoDir: active.repoDir, loop: active.loopName, step: active.stepId, turnKey: active.turnKey, reason, ...(round !== undefined ? { round } : {}) };
  };

  /** Refuse an Accept that has nothing to finalize, or whose finalize write failed (§27.12c): hold a live
   *  error for the active turn's identity and surface it, leaving Retry/Terminate the route out, without
   *  persisting a fabricated `complete`. Used by the unresolved-accept guards and the failed-write guards. */
  const refuseRouteOut = (kind: AppLoopErrorKind, reason: string, round?: number): void => {
    if (!active) return;
    setLiveError(kind, reason, round);
    deps.emitError(reason);
    deps.onViewChanged();
  };

  const completionSatisfied = (): boolean => {
    if (!active) return false;
    if (active.phase === 'consolidate') {
      // §27.6/AC3 — the consolidator advances only on a well-formed verdict (a value from the closed set and,
      // for `another round`, a non-empty roster ⊆ catalog). An `unresolved` consolidate turn reads nothing.
      if (active.completion.kind === 'unresolved') return false;
      const content = deps.readArtifact(active.outputPath);
      return content !== null && consolidatorOutputWellFormed(content, active.catalog);
    }
    if (active.phase === 'review') {
      // §27.12b — the review turn completes only on a well-formed round report: def-declared sections, full
      // roster accounting, per-issue elements. An `unresolved` review turn (resume lost the def) reads no
      // report — Accept cannot fabricate a pass, and the OVERRIDE path in routeOut is the human backstop.
      if (active.completion.kind === 'unresolved') return false;
      const content = deps.readArtifact(active.reportPath);
      return content !== null && roundReportWellFormed(content, { sections: active.sections, roster: active.reviewers.map((r) => r.persona) });
    }
    switch (active.completion.kind) {
      case 'commits':
        return true; // the done-signal alone completes it
      case 'unresolved':
        return false; // resume could not re-resolve the def — Accept must not fabricate a pass (CWE-754)
      case 'file':
        return artifactWellFormed(deps.readArtifact(active.completion.path), active.completion.marker);
    }
  };

  runner = createTurnRunner({
    compose: (turnKey) => {
      if (!active) return null;
      if (active.phase === 'consolidate') {
        if (active.completion.kind === 'unresolved') return null; // no def → cannot re-compose
        const body = deps.readRecipe(active.recipePath);
        if (body === null) return null;
        return composeConsolidatePrompt({
          recipeBody: body,
          catalog: active.catalog,
          reportRels: active.reportRels,
          outputRel: active.outputRel,
          round: active.round,
          turnKey,
          doneRelPath: APP_DONE_REL_PATH,
        });
      }
      if (active.phase === 'review') {
        if (active.completion.kind === 'unresolved') return null; // no def → cannot re-compose the roster
        return composeReviewAndFixPrompt({
          roster: active.reviewers,
          sections: active.sections,
          reportRel: active.reportRel,
          round: active.round,
          turnKey,
          doneRelPath: APP_DONE_REL_PATH,
          ...(active.feedback !== undefined ? { feedback: active.feedback } : {}),
        });
      }
      const body = deps.readRecipe(active.recipePath);
      if (body === null) return null;
      return composeAppWorkPrompt({
        recipeBody: body,
        turnKey,
        doneRelPath: APP_DONE_REL_PATH,
        completion: active.completion.kind === 'file' ? { artifactRel: active.completion.artifactRel, marker: active.completion.marker } : null,
        ...(active.instruction !== undefined ? { instruction: active.instruction } : {}),
      });
    },
    inject: (prompt, opts) => {
      // Clear the prior turn's done-signal at the PROMPT inject (not the preamble): any earlier and a
      // completion arriving during the boundary drain would be dropped (§26.3/D46 parallel).
      if (!opts?.preamble && active) clearTurnDone(active.repoDir, APP_TURN_DONE_SUBDIR);
      deps.inject(prompt);
    },
    hostedAgent: () => deps.hostedAgent(),
    artifactPresent: completionSatisfied,
    armTimer: () => deps.armTimer(),
    cancelTimer: () => deps.cancelTimer(),
    writeError: (reason) => {
      if (!active) return;
      const round = active.phase === 'review' || active.phase === 'consolidate' ? active.round : undefined;
      // Record the live error BEFORE persisting: emitError and the view fallback must surface the route-out
      // even when the persisted error write fails (§27.12c — never an unrecoverable dead-end).
      setLiveError('turn-error', reason, round);
      persist('error', reason);
      deps.audit(active.repoDir, turnErrorAuditCmd(active, reason), 1);
      deps.emitError(reason);
    },
    onComplete: (turnKey) => {
      if (!active) return;
      if (active.phase === 'work') {
        // §27.3 — advance straight into the review turn with no transient work-complete state, so a relaunch
        // never mistakes a mid-chain crash for a finished loop.
        deps.audit(active.repoDir, `§27 work turn ${turnKey} complete`, 0);
        enterReview(active, FIRST_ROUND);
        return;
      }
      if (active.phase === 'review') {
        // §27.6/AC1 — the review-and-fix round completed on a well-formed report; chain the consolidator with
        // no transient complete state (so a relaunch never mistakes a mid-chain crash for a finished loop).
        deps.audit(active.repoDir, reviewRoundAuditCmd('complete', active.round), 0);
        startConsolidate(active);
        return;
      }
      // §27.6 — the consolidator produced a well-formed verdict; branch on it (with the failed-lens guard and
      // the armed-interrupt override).
      finishConsolidate(active);
    },
    noteSettle: () => deps.noteSettle(),
  });

  const start = (turn: ActiveAppTurn): void => {
    active = turn;
    persist('working');
    deps.audit(turn.repoDir, `§27 work turn ${turn.turnKey} boundary: ${turn.boundaryCmd}`, null);
    runner.requestTurn(turn.turnKey, { preamble: turn.boundaryCmd });
  };

  /** Build the review-and-fix turn for a round from the resolved def and the round-keyed report location.
   *  `chosenRoster` (round ≥ 2, from the consolidator) narrows the def's catalog to the personas that round
   *  runs — a persona the catalog does not declare can never be invoked (§27.4), so an unknown one is simply
   *  filtered out. Round 1 (no `chosenRoster`) runs the full catalog. Returns null when the def no longer
   *  resolves or the report location is unresolvable (a routable error). */
  const reviewTurnFor = (ctx: TurnCtx, round: number, chosenRoster?: string[], feedback?: string): Extract<ActiveAppTurn, { phase: 'review' }> | null => {
    const r = deps.resolveDef(ctx.repoDir, ctx.loopName);
    if (!r.ok) return null;
    const loc = deps.resolveReportLocation(ctx.repoDir, round);
    if (!loc) return null;
    const full = reviewRoster(r.def);
    const reviewers = chosenRoster ? full.filter((e) => chosenRoster.includes(e.persona)) : full;
    return {
      phase: 'review',
      repoDir: ctx.repoDir,
      loopName: ctx.loopName,
      stepId: ctx.stepId,
      turnKey: `${REVIEW_TURN_PREFIX}${ctx.stepId}`,
      boundaryCmd: preReviewBoundaryCommand(r.def),
      round,
      reviewers,
      sections: r.def.report.sections,
      reportPath: loc.abs,
      reportRel: loc.rel,
      completion: { kind: 'report' },
      ...(chosenRoster ? { chosenRoster } : {}),
      ...(feedback !== undefined ? { feedback } : {}),
    };
  };

  /** Enter a review-and-fix round (§27.3/§27.6): cross the pre-review boundary, then inject the review prompt
   *  when injectable. Chained after a completed work turn (round 1) or after the consolidator's `another
   *  round` (round ≥ 2, over the chosen roster). A def or report-location that no longer resolves stops in a
   *  routable review `error` rather than silently dropping the round. */
  const enterReview = (ctx: TurnCtx, round: number, chosenRoster?: string[], feedback?: string): void => {
    const turn = reviewTurnFor(ctx, round, chosenRoster, feedback);
    if (turn) {
      active = turn;
      persist('working');
      deps.audit(ctx.repoDir, reviewRoundAuditCmd('boundary', round, turn.boundaryCmd), null);
      runner.requestTurn(turn.turnKey, { preamble: turn.boundaryCmd });
      return;
    }
    const reason = 'cannot resolve the review round (def or report location unresolvable)';
    active = { ...unresolvedReviewTurn({ ...ctx, turnKey: `${REVIEW_TURN_PREFIX}${ctx.stepId}`, round }), ...(chosenRoster ? { chosenRoster } : {}), ...(feedback !== undefined ? { feedback } : {}) };
    setLiveError('turn-error', reason, round);
    persist('error', reason);
    deps.audit(ctx.repoDir, reviewRoundAuditCmd('error', round, reason), 1);
    deps.emitError(reason);
  };

  /** Build the consolidator turn for a round from the resolved def, its output location, and the last-two
   *  report locations (§27.6/AC2). Returns null when any of those no longer resolve (a routable error). */
  const consolidateTurnFor = (ctx: TurnCtx, round: number): Extract<ActiveAppTurn, { phase: 'consolidate' }> | null => {
    const r = deps.resolveDef(ctx.repoDir, ctx.loopName);
    if (!r.ok) return null;
    const out = deps.resolveConsolidatorLocation(ctx.repoDir, round);
    if (!out) return null;
    const reportLocs = lastTwoReportRounds(round).map((rd) => deps.resolveReportLocation(ctx.repoDir, rd));
    if (reportLocs.some((l) => l === null)) return null;
    return {
      phase: 'consolidate',
      repoDir: ctx.repoDir,
      loopName: ctx.loopName,
      stepId: ctx.stepId,
      turnKey: `${CONSOLIDATE_TURN_PREFIX}${ctx.stepId}`,
      boundaryCmd: preConsolidateBoundaryCommand(r.def),
      round,
      catalog: catalogPersonas(r.def),
      recipePath: r.def.consolidator,
      outputPath: out.abs,
      outputRel: out.rel,
      reportRels: reportLocs.map((l) => l!.rel),
      reportPaths: reportLocs.map((l) => l!.abs),
      completion: { kind: 'output' },
    };
  };

  /** Chain the consolidator after a completed review round (§27.6/AC1): cross the pre-consolidate boundary,
   *  then inject the consolidator prompt when injectable. A def/location that no longer resolves stops in a
   *  routable consolidator `error` rather than silently dropping the turn. */
  const startConsolidate = (review: Extract<ActiveAppTurn, { phase: 'review' }>): void => {
    const ctx: TurnCtx = { repoDir: review.repoDir, loopName: review.loopName, stepId: review.stepId };
    const turn = consolidateTurnFor(ctx, review.round);
    if (turn) {
      active = turn;
      persist('working');
      deps.audit(ctx.repoDir, consolidateAuditCmd('boundary', review.round, turn.boundaryCmd), null);
      runner.requestTurn(turn.turnKey, { preamble: turn.boundaryCmd });
      return;
    }
    const reason = 'cannot resolve the consolidator turn (def, report, or output location unresolvable)';
    active = unresolvedConsolidateTurn({ ...ctx, turnKey: `${CONSOLIDATE_TURN_PREFIX}${ctx.stepId}`, round: review.round });
    setLiveError('turn-error', reason, review.round);
    persist('error', reason);
    deps.audit(ctx.repoDir, consolidateAuditCmd('error', review.round, reason), 1);
    deps.emitError(reason);
  };

  /** Persist a routed-to-gate consolidator turn (§27.6): record the verdict, its reason (gated), and the
   *  roster it chose, then stop at the gate (`complete`, N4 gate is display-only). */
  const routeConsolidateToGate = (turn: Extract<ActiveAppTurn, { phase: 'consolidate' }>, verdict: ConsolidatorVerdict, reason: string | undefined, roster: string[]): void => {
    turn.verdict = verdict;
    turn.verdictReason = verdictCarriesReason(verdict) ? reason : undefined;
    turn.chosenRoster = roster.length > 0 ? roster : undefined;
    if (!persist('complete')) {
      // §27.12c/CWE-703/755 — the `complete` write failed (ENOSPC/EPERM/a planted symlink), so the disk still
      // holds the pre-terminal `working`. This is the ONE transition whose purpose is to summon the human (a
      // `stop for a human`/`clean` gate); nulling liveError and leaving `working` would silently strand them.
      // Hold a live turn-error so the view keeps the retry/terminate route-out reachable, mirroring writeError.
      const saveFailReason = 'the consolidator finished but its verdict could not be saved — retry';
      refuseRouteOut('turn-error', saveFailReason, turn.round);
      return;
    }
    deps.audit(turn.repoDir, consolidateAuditCmd('complete', turn.round, verdict), 0);
  };

  /** Branch on a completed consolidator turn (§27.6): apply the failed-lens guard (AC7), honor a queued
   *  interrupt (AC9), then route on the effective verdict — `another round` re-enters review over the chosen
   *  roster, `clean`/`stop for a human` route to the gate. */
  const finishConsolidate = (turn: Extract<ActiveAppTurn, { phase: 'consolidate' }>): void => {
    const output = turn.completion.kind === 'output' ? deps.readArtifact(turn.outputPath) : null;
    const parsed = output !== null ? parseConsolidatorOutput(output) : null;
    // The completion gate already accepted a well-formed output; fall back to a human stop if a race leaves it
    // unreadable, never a silent clean.
    let verdict: ConsolidatorVerdict = parsed?.verdict ?? 'stop for a human';
    let roster = parsed?.roster ?? [];
    let reason = parsed?.reason ?? undefined;

    // §27.6/AC7 — the one engine-side override: a reviewer that FAILED TO RUN is never read as settled. Read
    // the last-two reports (AC2) and compare their failed lenses. A FRESH failure re-reviews with that lens;
    // a REPEAT failure (failed in the previous report too) stops for a human — bounding auto re-reviews to one
    // per lens-failure episode with no counter.
    const curPath = turn.reportPaths[turn.reportPaths.length - 1];
    const prevPath = turn.reportPaths.length === 2 ? turn.reportPaths[0] : null;
    const failedNow = new Set(curPath ? failedReviewers(deps.readArtifact(curPath) ?? '') : []);
    const failedPrev = new Set(prevPath ? failedReviewers(deps.readArtifact(prevPath) ?? '') : []);
    const repeat = [...failedNow].filter((p) => failedPrev.has(p));
    const fresh = [...failedNow].filter((p) => !failedPrev.has(p));
    if (repeat.length > 0) {
      verdict = 'stop for a human';
      reason = `a reviewer failed to run again and needs a human: ${repeat.join(', ')}`;
    } else if (fresh.length > 0 && verdict !== 'stop for a human') {
      // A fresh failure supersedes only clean / another-round — never an emitted `stop for a human`, which is a
      // human-owned decision (loop spinning, or a reviewer raised a needs-a-human issue) that §27.6 routes to
      // the gate now; the fresh lens is the human's to weigh there, not a reason to run another autonomous round.
      verdict = 'another round';
      roster = Array.from(new Set([...roster, ...fresh]));
    }

    // §27.9/AC9 — a queued interrupt for this step routes to the gate regardless of the verdict, still stating
    // the verdict it would otherwise have reached. One-shot: cleared when honored, and recorded as its own §25
    // event so the timeline distinguishes an interrupt-honored gate from a verdict-reached one.
    const armed = readArmedInterrupt(turn.repoDir);
    if (armed && armed.step === turn.stepId) {
      clearInterrupt(turn.repoDir);
      deps.audit(turn.repoDir, consolidateAuditCmd('interrupt', turn.round, verdict), 0);
      routeConsolidateToGate(turn, verdict, reason, roster);
      return;
    }

    if (verdict === 'another round') {
      deps.audit(turn.repoDir, consolidateAuditCmd('complete', turn.round, verdict), 0);
      enterReview({ repoDir: turn.repoDir, loopName: turn.loopName, stepId: turn.stepId }, turn.round + 1, roster);
      return;
    }
    routeConsolidateToGate(turn, verdict, reason, roster);
  };

  return {
    enter(repoDir, loopName, stepId) {
      if (runner.state() === 'in-flight') return; // §27.2 — never interleave a second turn
      const r = deps.resolveDef(repoDir, loopName);
      if (!r.ok) return; // AC6 — the def-failure view is produced at resolve time (loopViewV2)
      start(activeTurnFor(repoDir, loopName, stepId, r.def));
    },
    onInjectable() {
      runner.onInjectable();
    },
    onDoneSignal() {
      runner.onDoneSignal();
    },
    noteActivity() {
      runner.noteActivity();
    },
    onStall() {
      runner.onStall();
    },
    routeOut(repoDir, stepId, turnKey, action) {
      // §6 — act only on the turn the payload names; a decision for a turn the engine is not running is inert.
      if (!active || active.repoDir !== repoDir || active.stepId !== stepId || active.turnKey !== turnKey) return;
      if (action === 'terminate') {
        deps.terminateFlow(repoDir);
        return;
      }
      if (action === 'accept') {
        // §27.12c/CWE-703 — every Accept branch finalizes with `persist('complete')`; a failed finalize write
        // (ENOSPC/EPERM/a planted symlink) leaves the disk on `error`, so re-surface the live error and record
        // no `accept` the disk never saved, keeping Retry/Terminate the route out. One definition so the three
        // phases cannot drift on the write-failure contract.
        const acceptFinalize = (saveFailReason: string, successAudit: string, round?: number): void => {
          if (!persist('complete')) {
            refuseRouteOut('turn-error', saveFailReason, round);
            return;
          }
          deps.audit(repoDir, successAudit, 0);
        };
        if (active.phase === 'review') {
          // §27.12c/CWE-755 — an `unresolved` review turn (its def/report-location no longer resolves) has NO
          // report to keep, so the override has nothing to finalize; refuse it exactly as the work-turn guard
          // below does, surfacing def-unresolvable so Retry/Terminate stay the route out.
          if (active.completion.kind === 'unresolved') {
            refuseRouteOut('def-unresolvable', 'the review round no longer resolves — retry or terminate', active.round);
            return;
          }
          // §27.12c/CWE-754 — the override relaxes WELL-FORMEDNESS, not PRESENCE: it keeps a present-but-
          // malformed report, but a report that was never written has nothing to keep. Refuse it (present is
          // the one precondition §27.12c always requires) so finalizing `complete` can never record a round
          // with no auditable report (§27.5), keeping Retry/Terminate the route out.
          if (deps.readArtifact(active.reportPath) === null) {
            refuseRouteOut('turn-error', 'the review round has no report to accept — retry or terminate', active.round);
            return;
          }
          // §27.12c/AC8 — the review-turn accept is an OVERRIDE of the well-formedness gate, deliberately
          // divergent from the work turn's artifact-present accept: advance keeping the malformed report as
          // the round's record, WITHOUT re-running and WITHOUT re-injecting. Only a human can take it.
          acceptFinalize('the review round was accepted but could not be saved — retry or terminate', reviewRoundAuditCmd('accept', active.round), active.round);
          return;
        }
        if (active.phase === 'consolidate') {
          // §27.12c/AC12 — accept moves the consolidator turn off the error to its next state (the gate),
          // WITHOUT re-running or re-injecting. An `unresolved` turn (def/location gone) has nothing to keep,
          // so refuse it (def-unresolvable) exactly as the work/review guards do; a present-but-malformed
          // output is kept as the round's record and the loop stops at the gate for the human.
          if (active.completion.kind === 'unresolved') {
            refuseRouteOut('def-unresolvable', 'the consolidator turn no longer resolves — retry or terminate', active.round);
            return;
          }
          acceptFinalize('the consolidator turn was accepted but could not be saved — retry or terminate', consolidateAuditCmd('accept', active.round), active.round);
          return;
        }
        // §27.12c — accept a present work artifact: persist `complete` and stop, WITHOUT re-running and
        // WITHOUT injecting. A missing artifact is not acceptable — Retry (re-run) is that path.
        if (!completionSatisfied()) {
          // §27.12c/CWE-755 — an `unresolved` resumed turn (its def no longer resolves) can NEVER be
          // accepted; surface that instead of returning over the stale original reason with a dead affordance.
          if (active.completion.kind === 'unresolved') {
            refuseRouteOut('def-unresolvable', 'the bound def no longer resolves — retry or terminate');
          }
          return;
        }
        acceptFinalize('the work turn was accepted but could not be saved — retry or terminate', `§27 work turn ${turnKey} accepted (artifact present)`);
        return;
      }
      // retry — re-enter the same turn (boundary + prompt), gated on injectability (§27.12).
      persist('working');
      const retryAudit =
        active.phase === 'review'
          ? reviewRoundAuditCmd('retry', active.round)
          : active.phase === 'consolidate'
            ? consolidateAuditCmd('retry', active.round)
            : `§27 work turn ${turnKey} retry`;
      deps.audit(repoDir, retryAudit, null);
      runner.requestTurn(turnKey, { preamble: active.boundaryCmd });
    },
    requestChanges(repoDir, stepId, turnKey, feedback) {
      if (runner.state() === 'in-flight') return false; // §27.2 — never interleave a second turn
      // §27.9/AC6 — while polish stands the orchestrator down, no lever may re-enter a turn: the operator owns
      // the keyboard until approve ends it. A request-changes racing the stand-down is refused, not injected.
      if (deps.polishActive(repoDir)) return false;
      // §6/AC7 — identity + at-a-gate precondition; the round to iterate from is the gate's round, not a fresh counter.
      const state = readAppLoopState(repoDir);
      if (!state || state.step !== stepId || state.turnKey !== turnKey) return false;
      if (state.status !== 'complete' || state.verdict === undefined) return false;
      const round = state.round ?? FIRST_ROUND;
      // §27.9/AC4 — re-enter review at round+1 over the def's full catalog (fresh eyes on the human-driven
      // changes); undefined roster so the full catalog runs, never the consolidator or work turn.
      enterReview({ repoDir, loopName: state.loop, stepId }, round + 1, undefined, feedback);
      return true;
    },
    redo(repoDir, stepId, turnKey, instruction) {
      if (runner.state() === 'in-flight') return false; // §27.2 — never interleave a second turn
      // §27.9/AC6 — polish stands the orchestrator down: a redo racing the stand-down is refused, not injected.
      if (deps.polishActive(repoDir)) return false;
      // §6/AC7 — identity + at-a-gate precondition, exactly as request-changes; only a reached gate can redo.
      const state = readAppLoopState(repoDir);
      if (!state || state.step !== stepId || state.turnKey !== turnKey) return false;
      if (state.status !== 'complete' || state.verdict === undefined) return false;
      // §27.9/AC5 — re-enter the WORK turn on a clean slate carrying only the instruction. The def must resolve
      // (the work turn needs its recipe + completion contract); an unresolvable def is inert, not a fabricated
      // run. `start` crosses the entry boundary (clear/compact — the clean slate) then injects the work prompt,
      // which threads the instruction; no round, no feedback, no findings ride along (a fresh work run).
      const r = deps.resolveDef(repoDir, state.loop);
      if (!r.ok) return false;
      start(activeTurnFor(repoDir, state.loop, stepId, r.def, instruction));
      return true;
    },
    resume(repoDir) {
      const state = readAppLoopState(repoDir);
      if (!state) return;
      // Reconstruct which turn stopped so Retry/accept act on the right one — re-resolving the def so the
      // reconstructed turn carries its real completion contract (accept must read the true artifact). NEVER
      // re-drive it: an `error`/`complete` turn is human-owned; the runner stays idle until an explicit
      // route-out (§27.12).
      const ctx: TurnCtx = { repoDir, loopName: state.loop, stepId: state.step };
      // Make the reconstructed turn routable without re-driving it. An `error` turn carries its persisted
      // reason; a `working` turn is DEFINITIONALLY stopped by the relaunch — its PTY is gone and resume never
      // re-drives it — so it too gets a turn-error route-out, or the human is never summoned and the runner
      // sits idle (§27.12/CWE-703/755). A `complete` gate is human-owned and needs no live error.
      const makeRoutable = (round?: number): void => {
        if (state.status === 'error') setLiveError('turn-error', state.errorReason ?? 'error', round);
        else if (state.status === 'working') setLiveError('turn-error', RELAUNCH_INTERRUPTED_REASON, round);
      };
      if (state.turnKey.startsWith(CONSOLIDATE_TURN_PREFIX)) {
        const round = state.round ?? FIRST_ROUND;
        active = consolidateTurnFor(ctx, round) ?? unresolvedConsolidateTurn({ ...ctx, turnKey: state.turnKey, round });
        makeRoutable(round);
        return;
      }
      if (state.turnKey.startsWith(REVIEW_TURN_PREFIX)) {
        const round = state.round ?? FIRST_ROUND;
        active =
          reviewTurnFor(ctx, round, state.chosenRoster, state.feedback) ??
          {
            ...unresolvedReviewTurn({ ...ctx, turnKey: state.turnKey, round }),
            ...(state.chosenRoster ? { chosenRoster: state.chosenRoster } : {}),
            ...(state.feedback !== undefined ? { feedback: state.feedback } : {}),
          };
        makeRoutable(round);
        return;
      }
      const r = deps.resolveDef(repoDir, state.loop);
      active = r.ok
        ? activeTurnFor(repoDir, state.loop, state.step, r.def, state.instruction)
        : { phase: 'work', repoDir, loopName: state.loop, stepId: state.step, turnKey: state.turnKey, recipePath: '', boundaryCmd: '/clear', completion: { kind: 'unresolved' }, ...(state.instruction !== undefined ? { instruction: state.instruction } : {}) };
      makeRoutable();
    },
    activeTurnKey: () => active?.turnKey ?? null,
    activeRepoDir: () => active?.repoDir ?? null,
    liveErrorFor: (repoDir) => {
      if (!liveError || liveError.repoDir !== repoDir) return null;
      const { kind, loop, step, turnKey, reason, round } = liveError;
      return { kind, loop, step, turnKey, reason, ...(round !== undefined ? { round } : {}) };
    },
  };
}
