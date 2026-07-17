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
import { clearTurnDone } from './turnDoneFile';
import { TURN_DONE_FILENAME } from '../shared/loopTurn';
import { APP_LOOP_DIR_SEGMENTS, readAppLoopState, type AppLoopRunState } from './appLoopState';

/** The §27 done-file lives in the §27 loop area, disjoint from §26's `.agent-loop/` (AC10 separation). */
const APP_TURN_DONE_SUBDIR = path.join(...APP_LOOP_DIR_SEGMENTS);
const APP_DONE_REL_PATH = APP_LOOP_DIR_SEGMENTS.join('/') + '/' + TURN_DONE_FILENAME;

export type AppRouteOut = 'retry' | 'accept' | 'terminate';

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
  /** The current instant, stamped onto the persisted run state (§27.10). */
  now(): Date;
  /** Resolve the bound §27 def (§27.8); its reason surfaces at the view on failure (AC6). */
  resolveDef(loopName: string): LoopDefV2Result;
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
}

interface ActiveAppTurn {
  repoDir: string;
  loopName: string;
  stepId: string;
  turnKey: string;
  recipePath: string;
  boundaryCmd: string;
  /** The file-producing completion contract (confined artifact path + marker + repo-relative hint), or
   *  null for a commit-producing turn (done-signal alone). */
  completion: { path: string; marker: string; artifactRel: string } | null;
}

/** The entry context boundary before WORK (§27.3): the def's first declared boundary, defaulting to
 *  `clear` when the def names none (every turn boundary is clear-or-compact, §27.7). */
function entryBoundaryCommand(def: LoopDefV2): string {
  const first = def.boundaries[0];
  return first ? boundaryCommand(first) : '/clear';
}

function activeTurnFor(repoDir: string, loopName: string, stepId: string, def: LoopDefV2): ActiveAppTurn {
  const artifact = completionArtifact(def);
  return {
    repoDir,
    loopName,
    stepId,
    turnKey: `work-${stepId}`,
    recipePath: def.work.recipe,
    boundaryCmd: entryBoundaryCommand(def),
    completion: artifact
      ? { path: artifact.path, marker: completionMarker(stepId), artifactRel: path.relative(repoDir, artifact.path) }
      : null,
  };
}

export function createAppLoopEngine(deps: AppLoopEngineDeps): AppLoopEngine {
  let active: ActiveAppTurn | null = null;
  let runner: TurnRunner;

  const persist = (status: AppLoopRunState['status'], errorReason?: string): void => {
    if (!active) return;
    deps.persist(active.repoDir, {
      loop: active.loopName,
      step: active.stepId,
      turnKey: active.turnKey,
      status,
      ...(errorReason ? { errorReason } : {}),
    });
    deps.onViewChanged();
  };

  const artifactPresent = (): boolean => {
    if (!active) return false;
    if (active.completion === null) return true; // commit-producing: the done-signal alone completes it
    return artifactWellFormed(deps.readArtifact(active.completion.path), active.completion.marker);
  };

  runner = createTurnRunner({
    compose: (turnKey) => {
      if (!active) return null;
      const body = deps.readRecipe(active.recipePath);
      if (body === null) return null;
      return composeAppWorkPrompt({
        recipeBody: body,
        turnKey,
        doneRelPath: APP_DONE_REL_PATH,
        completion: active.completion ? { artifactRel: active.completion.artifactRel, marker: active.completion.marker } : null,
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
      persist('error', reason);
      deps.audit(active.repoDir, `§27 work turn ${active.turnKey} failed: ${reason}`, 1);
      deps.emitError(reason);
    },
    onComplete: (turnKey) => {
      if (!active) return;
      persist('complete');
      deps.audit(active.repoDir, `§27 work turn ${turnKey} complete`, 0);
    },
    noteSettle: () => deps.noteSettle(),
  });

  const start = (turn: ActiveAppTurn): void => {
    active = turn;
    persist('working');
    deps.audit(turn.repoDir, `§27 work turn ${turn.turnKey} boundary: ${turn.boundaryCmd}`, null);
    runner.requestTurn(turn.turnKey, { preamble: turn.boundaryCmd });
  };

  return {
    enter(repoDir, loopName, stepId) {
      if (runner.state() === 'in-flight') return; // §27.2 — never interleave a second turn
      const r = deps.resolveDef(loopName);
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
        // §27.12c — accept a present artifact: advance through the same completion chain a signalled turn
        // takes, WITHOUT re-running and WITHOUT injecting. A missing artifact is not acceptable — Retry
        // (re-run) is that path.
        if (!artifactPresent()) return;
        persist('complete');
        deps.audit(repoDir, `§27 work turn ${turnKey} accepted (artifact present)`, 0);
        return;
      }
      // retry — re-enter the same work turn (boundary + work), gated on injectability (§27.12).
      persist('working');
      deps.audit(repoDir, `§27 work turn ${turnKey} retry`, null);
      runner.requestTurn(turnKey, { preamble: active.boundaryCmd });
    },
    resume(repoDir) {
      const state = readAppLoopState(repoDir);
      if (!state) return;
      // Reconstruct which turn stopped so Retry/accept act on the right one — re-resolving the def so the
      // reconstructed turn carries its real completion contract (accept must read the true artifact). NEVER
      // re-drive it: an `error`/`complete` turn is human-owned; the runner stays idle until an explicit
      // route-out (§27.12).
      const r = deps.resolveDef(state.loop);
      active = r.ok
        ? activeTurnFor(repoDir, state.loop, state.step, r.def)
        : { repoDir, loopName: state.loop, stepId: state.step, turnKey: state.turnKey, recipePath: '', boundaryCmd: '/clear', completion: null };
    },
    activeTurnKey: () => active?.turnKey ?? null,
    activeRepoDir: () => active?.repoDir ?? null,
  };
}
