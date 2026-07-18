// The §27 (app-namespace) work-turn engine — the WRITE half of the coexistence seam (§27.15). On entry to
// an `app` flow step it runs the def's declared context boundary, injects the composed work prompt once
// through the §9.3 injector when injectable (§27.2), gates completion on the turn-keyed done-file plus (for
// a def that declares one) a well-formed completion artifact — present and carrying the marker the prompt
// instructed, never a quality judgment (§27.12) — retries once then stops in `error`, and persists run
// state to the app-owned §27 loop-state file so a relaunch reconstructs the stopped turn and never re-drives
// a completed one (§27.10/§27.12). The `error` route-out (retry / accept / terminate) acts on the step+turn
// identity it is handed, never ambient state (§6).
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
import { composeReviewAndFixPrompt, preReviewBoundaryCommand } from './reviewTurn';
import { clearTurnDone } from './turnDoneFile';
import { TURN_DONE_FILENAME } from '../shared/loopTurn';
import { roundReportWellFormed } from '../shared/roundReport';
import { reviewRoundAuditCmd } from '../shared/audit';
import { APP_LOOP_DIR_SEGMENTS, readAppLoopState, type AppLoopRunState } from './appLoopState';

/** The §27 done-file lives in the §27 loop area, disjoint from §26's `.agent-loop/` (AC10 separation). */
const APP_TURN_DONE_SUBDIR = path.join(...APP_LOOP_DIR_SEGMENTS);
const APP_DONE_REL_PATH = APP_LOOP_DIR_SEGMENTS.join('/') + '/' + TURN_DONE_FILENAME;

const WORK_TURN_PREFIX = 'work-';
const REVIEW_TURN_PREFIX = 'review-';
/** This slice runs round 1 only and stops with the report written; N4 adds the consolidator and later rounds. */
const FIRST_ROUND = 1;

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
    }
  | {
      phase: 'review';
      repoDir: string;
      loopName: string;
      stepId: string;
      turnKey: string;
      boundaryCmd: string;
      round: number;
      reviewers: { persona: string; charter: string }[];
      sections: string[];
      reportPath: string;
      reportRel: string;
      completion: { kind: 'report' } | { kind: 'unresolved' };
    };

/** The entry context boundary before WORK (§27.3): the def's first declared boundary, defaulting to
 *  `clear` when the def names none (every turn boundary is clear-or-compact, §27.7). */
function entryBoundaryCommand(def: LoopDefV2): string {
  const first = def.boundaries[0];
  return first ? boundaryCommand(first) : '/clear';
}

function activeTurnFor(repoDir: string, loopName: string, stepId: string, def: LoopDefV2): ActiveAppTurn {
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
  };
}

export function createAppLoopEngine(deps: AppLoopEngineDeps): AppLoopEngine {
  let active: ActiveAppTurn | null = null;
  let runner: TurnRunner;
  // The last errored turn, kept until it transitions out of error, so the view can surface the route-out
  // even when the persisted error write failed (§27.12c). Cleared on every non-error persist.
  let liveError: (AppLoopLiveError & { repoDir: string }) | null = null;

  const persist = (status: AppLoopRunState['status'], errorReason?: string): void => {
    if (!active) return;
    if (status !== 'error') liveError = null;
    const round = active.phase === 'review' ? active.round : undefined;
    try {
      deps.persist(active.repoDir, {
        loop: active.loopName,
        step: active.stepId,
        turnKey: active.turnKey,
        status,
        ...(errorReason ? { errorReason } : {}),
        ...(round !== undefined ? { round } : {}),
      });
    } catch (e) {
      // §27.10 resume state is best-effort: a write failure must never abort the turn's live path or crash
      // main from a timer/watcher callback (CLAUDE.md — a best-effort side effect never aborts its path;
      // CWE-703/755). The live error above keeps the route-out reachable this session even when the file
      // did not land.
      void (e instanceof Error ? e.message : String(e));
    }
    deps.onViewChanged();
  };

  const artifactPresent = (): boolean => {
    if (!active) return false;
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
      if (active.phase === 'review') {
        if (active.completion.kind === 'unresolved') return null; // no def → cannot re-compose the roster
        return composeReviewAndFixPrompt({
          roster: active.reviewers,
          sections: active.sections,
          reportRel: active.reportRel,
          round: active.round,
          turnKey,
          doneRelPath: APP_DONE_REL_PATH,
        });
      }
      const body = deps.readRecipe(active.recipePath);
      if (body === null) return null;
      return composeAppWorkPrompt({
        recipeBody: body,
        turnKey,
        doneRelPath: APP_DONE_REL_PATH,
        completion: active.completion.kind === 'file' ? { artifactRel: active.completion.artifactRel, marker: active.completion.marker } : null,
      });
    },
    inject: (prompt, opts) => {
      // Clear the prior turn's done-signal at the PROMPT inject (not the preamble): any earlier and a
      // completion arriving during the boundary drain would be dropped (§26.3/D46 parallel).
      if (!opts?.preamble && active) clearTurnDone(active.repoDir, APP_TURN_DONE_SUBDIR);
      deps.inject(prompt);
    },
    hostedAgent: () => deps.hostedAgent(),
    artifactPresent,
    armTimer: () => deps.armTimer(),
    cancelTimer: () => deps.cancelTimer(),
    writeError: (reason) => {
      if (!active) return;
      const round = active.phase === 'review' ? active.round : undefined;
      // Record the live error BEFORE persisting: emitError and the view fallback must surface the route-out
      // even when the persisted error write fails (§27.12c — never an unrecoverable dead-end).
      liveError = { kind: 'turn-error', repoDir: active.repoDir, loop: active.loopName, step: active.stepId, turnKey: active.turnKey, reason, ...(round !== undefined ? { round } : {}) };
      persist('error', reason);
      deps.audit(active.repoDir, round !== undefined ? reviewRoundAuditCmd('error', round, reason) : `§27 work turn ${active.turnKey} failed: ${reason}`, 1);
      deps.emitError(reason);
    },
    onComplete: (turnKey) => {
      if (!active) return;
      if (active.phase === 'work') {
        // §27.3 — the work turn completing does not stop the loop: chain the review-and-fix turn after the
        // def-declared pre-review boundary. The run-state advances straight to the review turn (no transient
        // work-complete state), so a relaunch never mistakes a mid-chain crash for a finished loop.
        deps.audit(active.repoDir, `§27 work turn ${turnKey} complete`, 0);
        startReview(active);
        return;
      }
      // §27.3/AC3 — the review-and-fix round completed on a well-formed report; stop here (N4 consolidates).
      persist('complete');
      deps.audit(active.repoDir, reviewRoundAuditCmd('complete', active.round), 0);
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
   *  Returns null when the def no longer resolves or the report location is unresolvable (a routable error). */
  const reviewTurnFor = (repoDir: string, loopName: string, stepId: string, round: number): ActiveAppTurn | null => {
    const r = deps.resolveDef(repoDir, loopName);
    if (!r.ok) return null;
    const loc = deps.resolveReportLocation(repoDir, round);
    if (!loc) return null;
    return {
      phase: 'review',
      repoDir,
      loopName,
      stepId,
      turnKey: `${REVIEW_TURN_PREFIX}${stepId}`,
      boundaryCmd: preReviewBoundaryCommand(r.def),
      round,
      reviewers: r.def.reviewers.map((rv) => ({ persona: rv.persona, charter: rv.charter })),
      sections: r.def.report.sections,
      reportPath: loc.abs,
      reportRel: loc.rel,
      completion: { kind: 'report' },
    };
  };

  /** Chain the review-and-fix turn after a completed work turn (§27.3): cross the pre-review boundary, then
   *  inject the review-and-fix prompt when injectable. A def or report-location that no longer resolves stops
   *  in a routable review `error` rather than silently dropping the round. */
  const startReview = (work: Extract<ActiveAppTurn, { phase: 'work' }>): void => {
    const turn = reviewTurnFor(work.repoDir, work.loopName, work.stepId, FIRST_ROUND);
    if (turn) {
      active = turn;
      persist('working');
      deps.audit(work.repoDir, reviewRoundAuditCmd('boundary', FIRST_ROUND, turn.boundaryCmd), null);
      runner.requestTurn(turn.turnKey, { preamble: turn.boundaryCmd });
      return;
    }
    const reason = 'cannot resolve the review round (def or report location unresolvable)';
    active = {
      phase: 'review',
      repoDir: work.repoDir,
      loopName: work.loopName,
      stepId: work.stepId,
      turnKey: `${REVIEW_TURN_PREFIX}${work.stepId}`,
      boundaryCmd: '/clear',
      round: FIRST_ROUND,
      reviewers: [],
      sections: [],
      reportPath: '',
      reportRel: '',
      completion: { kind: 'unresolved' },
    };
    liveError = { kind: 'turn-error', repoDir: work.repoDir, loop: work.loopName, step: work.stepId, turnKey: active.turnKey, reason, round: FIRST_ROUND };
    persist('error', reason);
    deps.audit(work.repoDir, reviewRoundAuditCmd('error', FIRST_ROUND, reason), 1);
    deps.emitError(reason);
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
        if (active.phase === 'review') {
          // §27.12c/CWE-755 — an `unresolved` review turn (its def/report-location no longer resolves) has NO
          // report to keep, so the override has nothing to finalize; refuse it exactly as the work-turn guard
          // below does, surfacing def-unresolvable so Retry/Terminate stay the route out.
          if (active.completion.kind === 'unresolved') {
            const reason = 'the review round no longer resolves — retry or terminate';
            liveError = { kind: 'def-unresolvable', repoDir, loop: active.loopName, step: active.stepId, turnKey: active.turnKey, reason, round: active.round };
            deps.emitError(reason);
            deps.onViewChanged();
            return;
          }
          // §27.12c/AC8 — the review-turn accept is an OVERRIDE of the well-formedness gate, deliberately
          // divergent from the work turn's artifact-present accept: advance keeping the malformed report as
          // the round's record, WITHOUT re-running and WITHOUT re-injecting. Only a human can take it.
          persist('complete');
          deps.audit(repoDir, reviewRoundAuditCmd('accept', active.round), 0);
          return;
        }
        // §27.12c — accept a present artifact: advance through the same completion chain a signalled turn
        // takes, WITHOUT re-running and WITHOUT injecting. A missing artifact is not acceptable — Retry
        // (re-run) is that path.
        if (!artifactPresent()) {
          // §27.12c/CWE-755 — an `unresolved` resumed turn (its def no longer resolves) can NEVER be
          // accepted; surface that instead of returning over the stale original reason with a dead affordance.
          if (active.completion.kind === 'unresolved') {
            const reason = 'the bound def no longer resolves — retry or terminate';
            liveError = { kind: 'def-unresolvable', repoDir, loop: active.loopName, step: active.stepId, turnKey: active.turnKey, reason };
            deps.emitError(reason);
            deps.onViewChanged();
          }
          return;
        }
        persist('complete');
        deps.audit(repoDir, `§27 work turn ${turnKey} accepted (artifact present)`, 0);
        return;
      }
      // retry — re-enter the same turn (boundary + prompt), gated on injectability (§27.12).
      persist('working');
      deps.audit(repoDir, active.phase === 'review' ? reviewRoundAuditCmd('retry', active.round) : `§27 work turn ${turnKey} retry`, null);
      runner.requestTurn(turnKey, { preamble: active.boundaryCmd });
    },
    resume(repoDir) {
      const state = readAppLoopState(repoDir);
      if (!state) return;
      // Reconstruct which turn stopped so Retry/accept act on the right one — re-resolving the def so the
      // reconstructed turn carries its real completion contract (accept must read the true artifact). NEVER
      // re-drive it: an `error`/`complete` turn is human-owned; the runner stays idle until an explicit
      // route-out (§27.12).
      if (state.turnKey.startsWith(REVIEW_TURN_PREFIX)) {
        const round = state.round ?? FIRST_ROUND;
        active =
          reviewTurnFor(repoDir, state.loop, state.step, round) ?? {
            phase: 'review',
            repoDir,
            loopName: state.loop,
            stepId: state.step,
            turnKey: state.turnKey,
            boundaryCmd: '/clear',
            round,
            reviewers: [],
            sections: [],
            reportPath: '',
            reportRel: '',
            completion: { kind: 'unresolved' },
          };
        if (state.status === 'error') {
          liveError = { kind: 'turn-error', repoDir, loop: state.loop, step: state.step, turnKey: state.turnKey, reason: state.errorReason ?? 'error', round };
        }
        return;
      }
      const r = deps.resolveDef(repoDir, state.loop);
      active = r.ok
        ? activeTurnFor(repoDir, state.loop, state.step, r.def)
        : { phase: 'work', repoDir, loopName: state.loop, stepId: state.step, turnKey: state.turnKey, recipePath: '', boundaryCmd: '/clear', completion: { kind: 'unresolved' } };
      if (state.status === 'error') {
        liveError = { kind: 'turn-error', repoDir, loop: state.loop, step: state.step, turnKey: state.turnKey, reason: state.errorReason ?? 'error' };
      }
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
