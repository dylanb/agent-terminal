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
// stall watchdog — is reused from the §27 turn runner (loopOrchestrator.ts); this module owns only the
// §27-specific run state, the artifact-marker gate,
// and the route-out. Every effect is a domain port the host wires to the injector, the §8.3 quiescence
// signal, the stall timer, the §27 loop-state writer, and the flow — never the primitives behind them.

import path from 'node:path';
import { createTurnRunner, type HostedAgentState, type PrecomputedGate, type TurnRunner } from './loopOrchestrator';
import type { LoopDefV2, LoopDefV2Result, PolishPolicy } from './loopDefV2';
import type { LifecycleTerminateResult } from './flowLifecycle';
import { artifactWellFormed, boundaryCommand, completionArtifact, completionMarker, composeAppWorkPrompt, sliceArtifact } from './appWorkTurn';
import type { LoopCompletionPredicates } from './loopCompletionPredicates';
import { RED_COMPLETING_OUTCOME, GREEN_COMPLETING_OUTCOME, REFACTOR_COMPLETING_OUTCOME, type PhaseOutcome } from '../shared/phaseOutcome';
import { GREEN_COMPLETING_BUILD_OUTCOME } from '../shared/buildOutcome';
import { resolveChainedInputs, type ChainedInput, type ChainedInputState } from './chainedInput';
import { catalogPersonas, composeReportRepairPrompt, composeReviewAndFixPrompt, preReviewBoundaryCommand, reviewRoster, type RosterEntry } from './reviewTurn';
import type { ArtifactCheck } from './artifactCheck';
import { composeConsolidatePrompt, composeVerdictRepairPrompt, lastTwoReportRounds, preConsolidateBoundaryCommand } from './consolidateTurn';
import { clearTurnDone } from './turnDoneFile';
import { TURN_DONE_FILENAME } from '../shared/loopTurn';
import { failedReviewers, roundReportProblems, roundReportWellFormed } from '../shared/roundReport';
import { consolidatorOutputProblems, consolidatorOutputWellFormed, parseConsolidatorOutput, verdictCarriesReason, type ConsolidatorVerdict } from '../shared/consolidatorOutput';
import { chainedTransitionAuditCmd, consolidateAuditCmd, reviewRoundAuditCmd } from '../shared/audit';
import { baselineForBranch, clearInterrupt, readAppLoopState, readArmedInterrupt, type AppLoopRunState, type PhaseBaseline, type SliceBrief } from './appLoopState';
import { APP_LOOP_DIR_SEGMENTS } from './appLoopPaths';
import type { AutoGate, GateCause } from './autoGate';

/** The §27 done-file lives in the §27 loop area, disjoint from the retired engine's `.agent-loop/` (AC10 separation). */
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

/** §19.2/§27.10 */
export type AppLoopEntry = 'chain-advance' | 'fresh-run' | 're-entry';
export type AppLoopEnterResult = 'entered' | 'busy' | 'unresolved';

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
  | { kind: 'red'; resultPath: string; resultRel: string }
  | { kind: 'green'; resultPath: string; resultRel: string }
  | { kind: 'commits' }
  | { kind: 'unresolved' };

export interface AppLoopEngineDeps {
  /** Inject + submit `text` into the hosted instance (§9.3). */
  inject(text: string): void;
  /** §27.9/AC6 — whether the polish stand-down is active for THIS step: the operator has taken the keyboard and
   *  the orchestrator must inject nothing until approve ends it. The engine consults this before running any
   *  lever that would re-enter a turn (redo, request-changes), so a decision racing the stand-down never
   *  restarts the orchestrator. Keyed on the step exactly as the view is (loopViewV2's `inPolish`) so the two
   *  cannot disagree on which gate is standing down. A domain predicate, not the app-loop-state file shape. */
  polishActive(repoDir: string, step: string): boolean;
  /** §27.9/AC6 — end a polish stand-down. The engine clears any stale stand-down when a fresh work turn ENTERS
   *  a step (a new clean-slate cycle owns no prior stand-down), so an abandoned polish (Terminated rather than
   *  approved, or a clear that failed) can never resurrect the polish view on a later same-step re-drive. */
  clearPolish(repoDir: string): void;
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
  /** §27.10 */
  inputState(absPath: string): ChainedInputState;
  /** Persist the §27 run state (§27.10). */
  persist(repoDir: string, state: AppLoopRunState): void;
  /** Record a §25 audit event for the turn (best-effort; never aborts the turn). */
  audit(repoDir: string, cmd: string, exit: number | null): void;
  /** §27-only error push so the renderer surfaces the reason (never a silent stop, §27.12/D48 parallel). */
  emitError(reason: string): void;
  /** The live loop view changed — the panel/strip re-pull. */
  onViewChanged(): void;
  /** Move the flow off the step (§27.9 abandon = flow Terminate) for the terminate route-out. */
  terminateFlow(repoDir: string): LifecycleTerminateResult;
  /** Resolve round N's report location (§27.5) — the confined absolute path the engine reads and the
   *  repo-relative path the fixer writes, from ONE resolver; null when the loop area is unresolvable. */
  resolveReportLocation(repoDir: string, round: number): { abs: string; rel: string } | null;
  /** Resolve round N's consolidator-output location (§27.6) — the confined absolute path the engine reads
   *  back to gate the turn and the repo-relative path the consolidator writes, from ONE resolver; null when
   *  the loop area is unresolvable. */
  resolveConsolidatorLocation(repoDir: string, round: number): { abs: string; rel: string } | null;
  /** §28.5.3 — resolve round N's refactor-result location: the confined absolute path (the R5 round gate reads
   *  it back) and the repo-relative path (threaded into the review prompt for the fixer to write), from ONE
   *  resolver; null when the loop area is unresolvable (a routable error, never a fabricated pass). Consulted
   *  only for a refactor loop's review round. */
  resolveRefactorResultLocation(repoDir: string, round: number): { abs: string; rel: string } | null;
  /** §28.5.3 — the machine completion predicates the phase gates consult (RED/GREEN and the refactor round) — a
   *  domain-concept seam. */
  completionPredicates: LoopCompletionPredicates;
  /** §28.5.3/§28.8.3 — record the GREEN turn's or refactor round's changed-test flag (the test-glob files the
   *  frozen check found changed since the RED baseline) under the turn's step. Best-effort here: the engine wraps
   *  the call so a write failure audits and never aborts the turn advance. A domain seam (composition root wires
   *  the disjoint `changed-tests.yaml` writer). */
  recordChangedTests(repoDir: string, step: string, paths: readonly string[]): void;
  /** §28.5.1 — the RED baseline (SHA + the branch it was recorded on) the GREEN frozen check diffs the working
   *  tree against. Null when unset; the GREEN gate blocks on an absent or branch-mismatched baseline (D-baseline).
   *  A domain seam (composition root wires `readBaselineCommit`). */
  readBaseline(repoDir: string): PhaseBaseline | null;
  /** §28.4 D2/#123 — clear the recorded baseline at a RED phase entry (a slice boundary), so a stale
   *  same-branch baseline from a prior phase/slice is not stale-matched by the next GREEN/refactor frozen
   *  check. A domain seam (composition root wires `clearBaselineCommit`); the caller wraps it best-effort. */
  clearBaseline(repoDir: string): void;
  /** §28.5.1 — the repo's current branch (the baseline's slice key), or null when detached/unresolvable. The
   *  frozen check matches it against the recorded baseline branch so the RED step's baseline is found by the
   *  GREEN step (they share the branch). A domain seam (composition root wires `currentGitBranch`). */
  currentBranch(repoDir: string): string | null;
  /** The GitHub refs the flow has resolved for a repo — the ticket/PR the work turn is operating on, the SAME
   *  identity the gate side-effects act on (resolveAppGateRefs). The composed work prompt names the ticket so
   *  the agent works the engine-resolved issue, never one re-derived from the branch/PR/cwd (CLAUDE.md). Null
   *  ticket when the flow has resolved none. A domain seam (composition root wires the resolved flow refs). */
  workRefs(repoDir: string): { ticket: number | null; pr: number | null };
  /** §28.4.2 — the operator's back-to-RED brief for the repo's CURRENT slice, or null when none is in force. */
  sliceBrief(repoDir: string): SliceBrief | null;
  /** §27.12 — the command line the agent runs to put a report or verdict through the loop's own format check. */
  artifactCheckCommand(check: ArtifactCheck): string;
  gateReaching?: AutoGate['gateReaching'];
  gateReached?: AutoGate['gateReached'];
  gateNotReached?: AutoGate['gateNotReached'];
  loopRunEvent?: AutoGate['loopRunEvent'];
  interruptArmed?: AutoGate['interruptArmed'];
  consumeInterrupt?: AutoGate['consumeInterrupt'];
}

export interface AppLoopEngine {
  /** §28.5.3 — the injected machine completion predicates, surfaced for the phase gates (RED/GREEN and the
   *  refactor round, S3/S4/S5). */
  completionPredicates: LoopCompletionPredicates;
  /** §27.10 — free to accept a new turn: the runner is idle AND no accepted-but-not-yet-requested turn
   *  occupies it (the §B.20a deferral gap counts as in-flight, so a second entry in the gap is refused). */
  canEnter(): boolean;
  /** §27.10 — enter a work turn. With `opts.deferRequest` (§B.20a / §B.5 item 6) the turn is ACCEPTED
   *  (answers `'entered'`, occupies the runner, persists `working`) but its `requestTurn` is DEFERRED to a
   *  caller-supplied trigger — the coordinator fires `triggerDeferredTurn` from the skill injection's own
   *  completion so the two injections never share the agent's input line (AC10/CWE-74). Without the flag the
   *  request fires synchronously on the initial arm, exactly as before. */
  enter(repoDir: string, loopName: string, stepId: string, entry: AppLoopEntry, opts?: { deferRequest?: boolean; slice?: number }): AppLoopEnterResult;
  /** §B.20a — fire a turn deferred by `enter({ deferRequest })` on the CHAINED arm (§B.5 item 4b): re-arm
   *  quiescence and wait for a fresh settle before injecting the boundary, so the deferred turn cannot race
   *  the skill injection whose completion triggered it. Inert if no turn is awaiting its trigger. */
  triggerDeferredTurn(): void;
  /** §B.20a / §B.5 item 6(a) — abandon a turn deferred by `enter({ deferRequest })` without requesting it,
   *  freeing the runner. The coordinator calls this on the deferral's deadline lapse before it reverts the
   *  step, so a turn is never left un-requested with the runner occupied. Inert if no turn is awaiting. */
  cancelDeferredTurn(): void;
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
  /** §27.12 — the flow for `repoDir` was terminated: a stalled turn there no longer resumes on its done-signal. */
  releaseStalledTurn(repoDir: string): void;
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
      /** §27.10 (N6) */
      inputs?: ChainedInput[];
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
      polish: PolishPolicy;
      reportPath: string;
      reportRel: string;
      /** §28.5.3 — a plain review round carries only its report (`report`); a GREEN loop's round is gated on its
       *  report alone but refreshes the changed-test flag (`green-report`); a REFACTOR loop's round also
       *  carries a round-keyed phase-result location (`refactor-report`: confined path + repo-rel) — the compose
       *  threads the rel, the R5 gate reads the path; an `unresolved` round (resume/entry lost the def or a
       *  location) reads nothing (Accept refuses). */
      completion:
        | { kind: 'report' }
        | { kind: 'green-report' }
        | { kind: 'refactor-report'; resultPath: string; resultRel: string }
        | { kind: 'unresolved' };
      /** The roster the consolidator chose for this round (§27.6/AC8); absent on round 1 (the full catalog). */
      chosenRoster?: string[];
      /** §27.9/AC4 — the operator's request-changes feedback carried into this round, threaded into the
       *  review prompt alongside the reviewers' findings; absent on a consolidator-driven another-round. */
      feedback?: string;
      /** §27.4 — the repo-relative work artifact the reviewers grade; absent when the work product is commits
       *  or a phase-result file. */
      subjectRel?: string;      /** §27.10/§27.4 — the inputs the step carried, named to the reviewers by path. */
      inputs?: ChainedInput[];
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
    polish: 'fix',
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

/** The work arm of an in-flight turn whose def no longer resolves (§27.12c): no recipe to read, no inputs to
 *  carry, `completion.kind === 'unresolved'` so Accept refuses it. Seeded identically by `resume`'s fallback
 *  and the retry lever's def-unresolvable refuse so the shape lives in one place (matching the review and
 *  consolidate seeders). Carries only the identity a later resolvable retry re-resolves the def by — no
 *  `recipePath`/`inputs` a `compose` could ever build a work prompt from for a turn whose def is gone. */
function unresolvedWorkTurn(args: TurnCtx & { turnKey: string; instruction?: string }): Extract<ActiveAppTurn, { phase: 'work' }> {
  return {
    phase: 'work',
    repoDir: args.repoDir,
    loopName: args.loopName,
    stepId: args.stepId,
    turnKey: args.turnKey,
    boundaryCmd: '/clear',
    recipePath: '',
    completion: { kind: 'unresolved' },
    ...(args.instruction !== undefined ? { instruction: args.instruction } : {}),
  };
}

/** The §25 audit command for a turn that stopped in `error`, keyed to the phase's vocabulary (§27.12). */
function turnErrorAuditCmd(turn: ActiveAppTurn, reason: string): string {
  if (turn.phase === 'review') return reviewRoundAuditCmd('error', turn.round, reason);
  if (turn.phase === 'consolidate') return consolidateAuditCmd('error', turn.round, reason);
  return `§27 work turn ${turn.turnKey} failed: ${reason}`;
}

function activeTurnFor(
  repoDir: string,
  loopName: string,
  stepId: string,
  def: LoopDefV2,
  opts?: { instruction?: string; inputs?: ChainedInput[]; slice?: number },
): ActiveAppTurn {
  // §28.4 D1 — a loop-back re-entry (slice N>1) targets its own `red-result.slice-N.md`; slice 1 is unsliced.
  const base = completionArtifact(def);
  const artifact = base ? sliceArtifact(base, opts?.slice ?? 1) : base;
  return {
    phase: 'work',
    repoDir,
    loopName,
    stepId,
    turnKey: `${WORK_TURN_PREFIX}${stepId}`,
    recipePath: def.work.recipe,
    boundaryCmd: entryBoundaryCommand(def),
    completion:
      def.work.completion === 'red' || def.work.completion === 'green'
        ? // §28.5.5 F1 — a fresh completion:red/green def is parse-guaranteed to have a result binding; only a
          // resumed turn whose def lost it lands here without one → unresolved (never a free-passing commits).
          // red and green share the result-file payload, differing only in the gate the completion kind selects.
          artifact
          ? { kind: def.work.completion, resultPath: artifact.path, resultRel: artifact.rel }
          : { kind: 'unresolved' }
        : def.work.completion === 'refactor'
          ? // §28.5.3/§28.6 — a refactor loop's work turn is a `commits` turn (the phase gate is on each review
            // ROUND, not the work turn), REGARDLESS of whether work.artifact resolves to a binding — so a
            // refactor def that names one can never become a marker-`file` turn that would never complete.
            { kind: 'commits' }
          : artifact
            ? { kind: 'file', path: artifact.path, marker: completionMarker(stepId), artifactRel: artifact.rel }
            : { kind: 'commits' },
    ...(opts?.instruction !== undefined ? { instruction: opts.instruction } : {}),
    ...(opts?.inputs && opts.inputs.length > 0 ? { inputs: opts.inputs } : {}),
  };
}

export function createAppLoopEngine(deps: AppLoopEngineDeps): AppLoopEngine {
  let active: ActiveAppTurn | null = null;
  // §B.20a — a turn accepted by `enter({ deferRequest })` whose `requestTurn` is deferred to a caller
  // trigger. Set true from `entered` until `triggerDeferredTurn`/`cancelDeferredTurn`; while true the runner
  // reads as occupied (canEnter/enter refuse) even though `runner.state()` is still idle (§B.5 item 6(b)).
  let awaitingTrigger = false;
  // §28.5.3 — the RED/GREEN turn whose async completion gate is currently in flight. The host done-file watcher
  // (turnDoneFile) is NOT debounced — it leans on the runner being synchronously idempotent — but the async gate
  // breaks that: two done-signals for one write would spawn two gates, and the second (stale) would land on a
  // just-injected retry, collapsing MAX_ATTEMPTS or (if git state flips between the two checks) fabricating a
  // pass. This flag suppresses a duplicate signal WHILE a gate is pending; a genuine retry's real done-signal
  // (after the flag clears) still spawns a fresh gate. One slot suffices — only one work turn is active at a time.
  let asyncGatePendingFor: ActiveAppTurn | null = null;
  // §28.5.3/§28.8.3 — the changed-test paths AWAITING their record (a distinct sense from `asyncGatePendingFor`,
  // which tracks an in-flight gate): resolved by greenAsyncGate on a GREEN work turn or reviewRoundFrozenProbe on a
  // GREEN/refactor review round, drained by that turn's onComplete. Identity-carrying (`turn`) so a stale gate/probe
  // resolving after a retry rebuilt `active` cannot record its paths against the fresh turn.
  let changedTestsToRecord: { turn: ActiveAppTurn; paths: string[] } | null = null;
  let runner: TurnRunner;
  // The last errored turn, kept until it transitions out of error, so the view can surface the route-out
  // even when the persisted error write failed (§27.12c). Cleared on every non-error persist.
  let liveError: (AppLoopLiveError & { repoDir: string }) | null = null;

  /** §27.10 */
  let stepCarry: { repoDir: string; stepId: string; ids: string[] } | null = null;

  const setCarry = (repoDir: string, stepId: string, ids: string[]): void => {
    stepCarry = { repoDir, stepId, ids };
  };

  const liveCarry = (repoDir: string, stepId: string): string[] | null =>
    stepCarry !== null && stepCarry.repoDir === repoDir && stepCarry.stepId === stepId ? stepCarry.ids : null;

  const recordedCarry = (repoDir: string, stepId: string, persisted: AppLoopRunState | null): string[] =>
    liveCarry(repoDir, stepId) ?? (persisted?.step === stepId ? (persisted.chainedInputs ?? []) : []);

  type CarryOccasion =
    | { kind: 'advance' }
    | { kind: 're-enter'; ids: string[] }
    | { kind: 'reconstruct'; ids: string[] };

  const chainFor = (repoDir: string, stepId: string, def: LoopDefV2, occasion: CarryOccasion): ChainedInput[] => {
    const bindings = occasion.kind === 'advance' ? def.inputs : def.inputs.filter((i) => occasion.ids.includes(i.id));
    const chain = resolveChainedInputs(bindings, (absPath) => deps.inputState(absPath));
    const announces = occasion.kind !== 'reconstruct';
    if (occasion.kind === 'advance' && (chain.carried.length > 0 || chain.unresolved.length > 0)) {
      deps.audit(
        repoDir,
        chainedTransitionAuditCmd(
          stepId,
          chain.carried.map((i) => i.id),
          chain.unresolved.map((u) => u.id),
        ),
        chain.unresolved.length > 0 ? 1 : 0,
      );
    }
    const unreadable = chain.unresolved.filter((u) => u.state === 'unreadable').map((u) => u.id);
    const declared = new Set(def.inputs.map((i) => i.id));
    const stranded =
      occasion.kind === 'advance'
        ? []
        : [
            ...occasion.ids.filter((id) => !declared.has(id)),
            ...chain.unresolved.filter((u) => u.state === 'not-produced').map((u) => u.id),
          ];
    const notes = [
      ...(unreadable.length > 0 ? [`declared input(s) present but unreadable — ${unreadable.join(', ')}`] : []),
      ...(stranded.length > 0 ? [`recorded input(s) no longer available — ${stranded.join(', ')}`] : []),
    ];
    if (announces && notes.length > 0) deps.emitError(`${stepId}: ${notes.join('; ')}`);
    return chain.carried;
  };

  /** §27.10 */
  const reEnter = (
    repoDir: string,
    stepId: string,
    def: LoopDefV2,
    persisted: AppLoopRunState | null,
  ): { ids: string[]; inputs: ChainedInput[] } => {
    const ids = recordedCarry(repoDir, stepId, persisted);
    return { ids, inputs: chainFor(repoDir, stepId, def, { kind: 're-enter', ids }) };
  };

  // §27.9.1 — the gate-authority hooks report facts to the controller; a hook that throws never aborts the turn.
  const hook = (call: () => void): void => {
    try {
      call();
    } catch (e) {
      void (e instanceof Error ? e.message : String(e));
    }
  };

  const persist = (status: AppLoopRunState['status'], errorReason?: string, notify = true): boolean => {
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
    // §27.10
    const chainedInputs = liveCarry(active.repoDir, active.stepId) ?? undefined;
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
        ...(chainedInputs !== undefined && chainedInputs.length > 0 ? { chainedInputs } : {}),
      });
    } catch (e) {
      // §27.10 resume state is best-effort: a write failure must never abort the turn's live path or crash
      // main from a timer/watcher callback (CLAUDE.md — a best-effort side effect never aborts its path;
      // CWE-703/755). The caller learns the write did not land so a terminal completion can still hold a live
      // error and summon the human, instead of stranding the disk at a stale `working`.
      void (e instanceof Error ? e.message : String(e));
      landed = false;
    }
    if (notify) deps.onViewChanged();
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

  /** The phase-result clause (§28.5.3): the result is present, well-formed, and classifies `want`. The echoed
   *  outcome is a member of the closed PhaseOutcome set (only a well-formed result yields one), never file text. */
  const resultShortfall = (rel: string, content: string | null, want: PhaseOutcome): string | null => {
    if (content === null) return `the phase result ${rel} is missing`;
    const outcome = deps.completionPredicates.resultOutcome(content);
    if (outcome === null) return `the phase result ${rel} is not well-formed`;
    return outcome === want ? null : `the phase result ${rel} reports ${outcome}, not ${want}`;
  };

  const UNRESOLVED_SHORTFALL = 'the loop definition no longer resolves';

  const completionShortfall = (): string | null => {
    if (!active) return 'no turn is active';
    if (active.phase === 'consolidate') {
      // §27.6/AC3 — the consolidator advances only on a well-formed verdict (a value from the closed set and,
      // for `another round`, a non-empty roster ⊆ catalog). An `unresolved` consolidate turn reads nothing.
      if (active.completion.kind === 'unresolved') return UNRESOLVED_SHORTFALL;
      const content = deps.readArtifact(active.outputPath);
      if (content === null) return `the consolidator verdict ${active.outputRel} is missing`;
      return consolidatorOutputWellFormed(content, active.catalog) ? null : `the consolidator verdict ${active.outputRel} is not well-formed`;
    }
    if (active.phase === 'review') {
      // §27.12b — the review turn completes only on a well-formed round report: def-declared sections, full
      // roster accounting, per-issue elements. An `unresolved` review turn (resume lost the def) reads no
      // report — Accept cannot fabricate a pass, and the OVERRIDE path in routeOut is the human backstop.
      if (active.completion.kind === 'unresolved') return UNRESOLVED_SHORTFALL;
      const content = deps.readArtifact(active.reportPath);
      if (content === null) return `the round report ${active.reportRel} is missing`;
      if (!roundReportWellFormed(content, { sections: active.sections, roster: active.reviewers.map((r) => r.persona) })) {
        return `the round report ${active.reportRel} is not well-formed`;
      }
      if (active.completion.kind === 'refactor-report') {
        // §28.5.3 — a REFACTOR round's SYNC clause: {result shape-valid ∧ outcome == passed}, softer than GREEN
        // (no build). The exit-direction is the async refactorAsyncGate (§28.5.3:124); the frozen check is a
        // non-blocking side probe, NOT part of this gate (§28.8.3).
        const { resultRel, resultPath } = active.completion;
        return resultShortfall(resultRel, deps.readArtifact(resultPath), REFACTOR_COMPLETING_OUTCOME);
      }
      return null;
    }
    switch (active.completion.kind) {
      case 'commits':
        return null; // the done-signal alone completes it
      case 'unresolved':
        return UNRESOLVED_SHORTFALL; // resume could not re-resolve the def — Accept must not fabricate a pass (CWE-754)
      case 'file': {
        const { artifactRel, path, marker } = active.completion;
        const content = deps.readArtifact(path);
        if (content === null) return `the turn artifact ${artifactRel} is missing`;
        return artifactWellFormed(content, marker) ? null : `the turn artifact ${artifactRel} does not carry its completion marker`;
      }
      case 'red':
        // §28.5.3 — the SYNCHRONOUS RED clause: the result file is shape-valid AND classifies `failed-assertion`
        // (via the injected resultOutcome, which returns the outcome only for a well-formed result — AC3). The
        // async "a test file was added" + exit-direction clauses are the engine's redAsyncGate; BOTH completion
        // routes AND it in — the done-signal via the runner's PrecomputedGate (§28 Option C), the human-accept
        // via routeOut computing the same gate — so AC2 holds on both paths (§28.5.6 keeps "a test was added"
        // machine-authoritative, not a human-override target).
        return resultShortfall(active.completion.resultRel, deps.readArtifact(active.completion.resultPath), RED_COMPLETING_OUTCOME);
      case 'green': {
        // §28.5.3 — the SYNCHRONOUS GREEN clause: the result file is shape-valid AND classifies `passed` AND its
        // build classifies `built` (both from the injected predicates, which return a value only for a well-formed
        // result). The async clauses (baseline present+branch-matched, the exit-direction, and the NON-blocking
        // frozen detection) are the engine's greenAsyncGate, ANDed on both completion routes like the RED gate.
        const { resultRel, resultPath } = active.completion;
        const content = deps.readArtifact(resultPath);
        const outcome = resultShortfall(resultRel, content, GREEN_COMPLETING_OUTCOME);
        if (outcome !== null || content === null) return outcome;
        const build = deps.completionPredicates.resultBuildOutcome(content);
        return build === GREEN_COMPLETING_BUILD_OUTCOME ? null : `the phase result ${resultRel} reports build ${build ?? 'unclassified'}, not ${GREEN_COMPLETING_BUILD_OUTCOME}`;
      }
    }
  };

  const completionSatisfied = (): boolean => completionShortfall() === null;

  // §28.5.4/CWE-117 — map the closed capabilities-load `cause` enum to a STATIC operator reason, NEVER embedding
  // the load failure's `.reason` (whose malformed arm can carry untrusted repo yaml text).
  const capabilitiesCauseReason = (cause: 'absent' | 'malformed' | 'confinement'): string =>
    cause === 'confinement'
      ? 'the repository loop-capabilities path is refused'
      : cause === 'malformed'
        ? 'the repository loop-capabilities file is malformed'
        : 'the repository has no loop-capabilities file';

  // §28.5.3/CWE-117 — the baseline-sourced consumers (the GREEN gate + the refactor probe) read the cause from
  // the baseline COMMIT's blob, so the wording names the baseline commit, distinct from capabilitiesCauseReason's
  // working-tree "repository" text. Static strings only, never the untrusted `.reason`.
  const baselineCapabilitiesCauseReason = (cause: 'absent' | 'malformed'): string =>
    cause === 'malformed'
      ? 'the RED baseline commit has a malformed loop-capabilities file'
      : 'the RED baseline commit has no loop-capabilities file — commit it and re-run RED';

  /** §28.5.3 / §28 Option C — the RED turn's ASYNC machine ground truth (git + best-effort exit code), computed
   *  in the engine and threaded to the sync runner as a PrecomputedGate on the done-signal. A false gate carries
   *  a distinct reason so the operator surface never mislabels it as a completion shortfall. Never
   *  rejects — an unexpected throw is a fail-toward-firing gate. */
  const redAsyncGate = async (a: ActiveAppTurn): Promise<PrecomputedGate> => {
    try {
      const added = await deps.completionPredicates.workingTreeTestPaths({ repoDir: a.repoDir });
      if (!added.ok) {
        return { ok: false, reason: `RED cannot verify a test was added — ${capabilitiesCauseReason(added.cause)}` };
      }
      if (added.paths.length === 0) {
        return { ok: false, reason: 'RED requires a failing test — no test file was added this turn' };
      }
      const exit = await deps.completionPredicates.recoverExitCode({ repoDir: a.repoDir, turnKey: a.turnKey });
      // §28.5.2a — exit 0 ⇒ the agent may not claim RED. DORMANT until N7/#92 wires a source (recoverExitCode
      // returns null today), but a real, tested bound: injecting an exit code exercises this direction.
      if (exit !== null && exit === 0) {
        return { ok: false, reason: 'the test command exited 0 — that is not a RED failure' };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: `RED completion check failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  };

  /** §28.5.1 — the frozen check's shared core, consumed by both the GREEN gate and the refactor probe. */
  const changedTestPathsSinceBaseline = async (
    a: ActiveAppTurn,
  ): Promise<{ kind: 'ok'; paths: string[] } | { kind: 'no-baseline' } | { kind: 'capfail'; cause: 'absent' | 'malformed' }> => {
    const baseline = baselineForBranch(deps.readBaseline(a.repoDir), deps.currentBranch(a.repoDir));
    if (baseline === null) return { kind: 'no-baseline' };
    const changed = await deps.completionPredicates.changedTestPaths({ repoDir: a.repoDir, baseline: baseline.sha });
    if (!changed.ok) return { kind: 'capfail', cause: changed.cause };
    return { kind: 'ok', paths: changed.paths };
  };

  /** §28.5.3 / §28 Option C — the GREEN turn's ASYNC machine ground truth. Returns the PrecomputedGate (baseline
   *  present + branch-matched, then the exit-direction) AND the frozen-check paths the NON-blocking flag records
   *  (or `null` when the check could not run — in which case the gate blocks). The frozen RESULT never sets the
   *  gate false (§28.8.3 detect-and-escalate); only the baseline guard and exit-direction do. Never rejects — an
   *  unexpected throw is a fail-toward-firing gate. */
  const greenAsyncGate = async (
    a: ActiveAppTurn,
  ): Promise<{ gate: PrecomputedGate; changedTests: string[] | null }> => {
    try {
      // §28.5.1/D-baseline — a missing, branch-mismatched, or detached-HEAD baseline means "tests unchanged"
      // cannot be proven, so the gate BLOCKS (fail toward firing), never silently reading as "nothing changed".
      const changed = await changedTestPathsSinceBaseline(a);
      if (changed.kind !== 'ok') {
        const reason =
          changed.kind === 'no-baseline'
            ? 'GREEN cannot run the frozen check — no RED baseline is recorded for this branch'
            : `GREEN cannot run the frozen check — ${baselineCapabilitiesCauseReason(changed.cause)}`;
        return { gate: { ok: false, reason }, changedTests: null };
      }
      const exit = await deps.completionPredicates.recoverExitCode({ repoDir: a.repoDir, turnKey: a.turnKey });
      // §28.5.2a — exit non-zero ⇒ the agent may not claim GREEN (OPPOSITE of RED's exit-0 clause). DORMANT until
      // N7/#92 wires a source; injecting an exit code exercises the direction.
      if (exit !== null && exit !== 0) {
        return { gate: { ok: false, reason: `the test command exited ${exit} — that is not a GREEN pass` }, changedTests: null };
      }
      return { gate: { ok: true }, changedTests: changed.paths };
    } catch (e) {
      return {
        gate: { ok: false, reason: `GREEN completion check failed: ${e instanceof Error ? e.message : String(e)}` },
        changedTests: null,
      };
    }
  };

  /** §28.5.3/§28.8.3 — a GREEN or REFACTOR review round's frozen check as a NON-blocking side probe (unlike the
   *  GREEN work gate it never blocks the round; an inability records no flag and is AUDITED, never silently
   *  swallowed — CLAUDE.md). */
  const reviewRoundFrozenProbe = async (a: ActiveAppTurn): Promise<string[] | null> => {
    try {
      const changed = await changedTestPathsSinceBaseline(a);
      if (changed.kind === 'ok') return changed.paths;
      const why =
        changed.kind === 'no-baseline'
          ? 'no RED baseline is recorded for this branch (recorded on a different branch, or detached HEAD)'
          : baselineCapabilitiesCauseReason(changed.cause);
      deps.audit(a.repoDir, `§28 review round frozen probe could not run — ${why}`, 1);
      return null;
    } catch (e) {
      deps.audit(a.repoDir, `§28 review round frozen probe error: ${e instanceof Error ? e.message : String(e)}`, 1);
      return null;
    }
  };

  /** §28.5.3:124 — the REFACTOR round's ASYNC exit-direction gate: a round may not complete claiming `passed`
   *  while the recoverable test exit is non-zero (the same direction as GREEN, §28 Option C). Unlike GREEN it does
   *  NOT block on the baseline — the frozen check is a non-blocking side probe. Never rejects — an unexpected throw
   *  is a fail-toward-firing gate. */
  const refactorAsyncGate = async (a: ActiveAppTurn): Promise<PrecomputedGate> => {
    try {
      const exit = await deps.completionPredicates.recoverExitCode({ repoDir: a.repoDir, turnKey: a.turnKey });
      // §28.5.2a/§28.5.3 — exit non-zero ⇒ the round may not claim `passed` (the GREEN direction). DORMANT until
      // N7/#92 wires a source; injecting an exit code exercises the direction.
      if (exit !== null && exit !== 0) {
        return { ok: false, reason: `the test command exited ${exit} — that is not a passing refactor round` };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: `refactor completion check failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  };

  /** §28.5.3/§28.8.3 — record the changed-test flag best-effort: a write failure is audited and NEVER aborts the
   *  turn advance (CODE-STANDARDS best-effort side effect, coercing the caught value as unknown). Called on both
   *  completion routes (the done-signal via onComplete, the human-accept via routeOut), for a GREEN work turn
   *  and a GREEN/refactor review round alike. */
  const recordChangedTestsFlag = (a: ActiveAppTurn, paths: string[]): void => {
    try {
      deps.recordChangedTests(a.repoDir, a.stepId, paths);
    } catch (e) {
      deps.audit(a.repoDir, `§28 ${a.phase} turn ${a.turnKey} changed-tests flag record failed: ${e instanceof Error ? e.message : String(e)}`, 1);
    }
  };

  /** §28.5.3 — the changed-test flag stash idiom, ONE definition shared by the GREEN work turn and the GREEN/refactor
   *  review round so the stale-guard contract cannot drift between routes. */
  const stashChangedTests = (turn: ActiveAppTurn, changedTests: string[] | null): void => {
    if (changedTests !== null) changedTestsToRecord = { turn, paths: changedTests };
  };
  const drainChangedTestsStash = (turn: ActiveAppTurn): void => {
    if (changedTestsToRecord?.turn === turn) recordChangedTestsFlag(turn, changedTestsToRecord.paths);
    changedTestsToRecord = null;
  };

  /** §28.4.2 — the brief a RED/GREEN/refactor phase turn carries; other loops never see one. */
  const briefFor = (turn: ActiveAppTurn): { sliceBrief: SliceBrief } | Record<string, never> => {
    const r = deps.resolveDef(turn.repoDir, turn.loopName);
    if (!r.ok || r.def.work.completion === undefined) return {};
    const brief = deps.sliceBrief(turn.repoDir);
    return brief !== null ? { sliceBrief: brief } : {};
  };

  const reportCheck = (turn: Extract<ActiveAppTurn, { phase: 'review' }>): Extract<ArtifactCheck, { kind: 'report' }> => ({
    kind: 'report',
    rel: turn.reportRel,
    sections: turn.sections,
    roster: turn.reviewers.map((r) => r.persona),
  });
  const verdictCheck = (turn: Extract<ActiveAppTurn, { phase: 'consolidate' }>): ArtifactCheck => ({
    kind: 'verdict',
    rel: turn.outputRel,
    catalog: turn.catalog,
  });

  /** §27.12 — the retry for a review or consolidator turn whose report/verdict is ON DISK but malformed: a
   *  repair of that file alone, naming each problem. Null (→ the full turn is re-injected) when there is no
   *  file to repair, the turn is some other kind, or the shortfall lies elsewhere (a refactor round's result). */
  const composeRepair = (): string | null => {
    if (!active) return null;
    if (active.phase === 'review' && active.completion.kind !== 'unresolved') {
      const content = deps.readArtifact(active.reportPath);
      if (content === null) return null;
      const check = reportCheck(active);
      const problems = roundReportProblems(content, check);
      if (problems.length === 0) return null;
      if (active.completion.kind === 'refactor-report') {
        const { resultRel, resultPath } = active.completion;
        if (resultShortfall(resultRel, deps.readArtifact(resultPath), REFACTOR_COMPLETING_OUTCOME) !== null) return null;
      }
      return composeReportRepairPrompt({
        reportRel: active.reportRel,
        problems,
        sections: check.sections,
        roster: check.roster,
        round: active.round,
        turnKey: active.turnKey,
        doneRelPath: APP_DONE_REL_PATH,
        checkCommand: deps.artifactCheckCommand(check),
      });
    }
    if (active.phase === 'consolidate' && active.completion.kind !== 'unresolved') {
      const content = deps.readArtifact(active.outputPath);
      if (content === null) return null;
      const problems = consolidatorOutputProblems(content, active.catalog);
      if (problems.length === 0) return null;
      return composeVerdictRepairPrompt({
        outputRel: active.outputRel,
        problems,
        catalog: active.catalog,
        round: active.round,
        turnKey: active.turnKey,
        doneRelPath: APP_DONE_REL_PATH,
        checkCommand: deps.artifactCheckCommand(verdictCheck(active)),
      });
    }
    return null;
  };

  runner = createTurnRunner({
    compose: (turnKey, retry) => {
      if (!active) return null;
      const repair = retry !== undefined ? composeRepair() : null;
      if (repair !== null) return repair;
      if (active.phase === 'consolidate') {
        if (active.completion.kind === 'unresolved') return null; // no def → cannot re-compose
        const body = deps.readRecipe(active.recipePath);
        if (body === null) return null;
        // §19.1 — bind the consolidator to the engine-resolved issue it judges the round against, the SAME
        // identity the work turn and gate side-effects use, never one re-derived from the branch/PR/cwd.
        const consolidateTicket = deps.workRefs(active.repoDir).ticket;
        return composeConsolidatePrompt({
          recipeBody: body,
          catalog: active.catalog,
          reportRels: active.reportRels,
          outputRel: active.outputRel,
          round: active.round,
          turnKey,
          doneRelPath: APP_DONE_REL_PATH,
          checkCommand: deps.artifactCheckCommand(verdictCheck(active)),
          ...(consolidateTicket !== null ? { ticket: consolidateTicket } : {}),
        });
      }
      if (active.phase === 'review') {
        if (active.completion.kind === 'unresolved') return null; // no def → cannot re-compose the roster
        // §19.1 — the ticket handed to each reviewer is the engine-resolved issue, the SAME identity every other
        // turn binds to, never one a reviewer re-derives from the branch/PR/cwd.
        const reviewTicket = deps.workRefs(active.repoDir).ticket;
        return composeReviewAndFixPrompt({
          roster: active.reviewers,
          sections: active.sections,
          polish: active.polish,
          reportRel: active.reportRel,
          round: active.round,
          turnKey,
          doneRelPath: APP_DONE_REL_PATH,
          checkCommand: deps.artifactCheckCommand(reportCheck(active)),
          ...(reviewTicket !== null ? { ticket: reviewTicket } : {}),
          ...(active.subjectRel !== undefined ? { subjectRel: active.subjectRel } : {}),
          ...(active.inputs !== undefined ? { inputs: active.inputs } : {}),
          ...briefFor(active),
          ...(active.feedback !== undefined ? { feedback: active.feedback } : {}),
          // §28.5.3 — a refactor round carries its round-keyed result path so the composer appends the
          // phase-result instruction; a plain review round has no `refactor-report` completion and none.
          ...(active.completion.kind === 'refactor-report' ? { resultRel: active.completion.resultRel } : {}),
        });
      }
      const body = deps.readRecipe(active.recipePath);
      if (body === null) return null;
      // Bind the work prompt to the ticket the flow resolved — the SAME identity the gate side-effects write to
      // — so the agent works the engine-resolved issue, never one inferred from the branch/PR/cwd (CLAUDE.md).
      const ticket = deps.workRefs(active.repoDir).ticket;
      return composeAppWorkPrompt({
        recipeBody: body,
        turnKey,
        doneRelPath: APP_DONE_REL_PATH,
        ...(ticket !== null ? { ticket } : {}),
        // §28.5.5 §7d
        completion:
          active.completion.kind === 'file'
            ? { kind: 'file', artifactRel: active.completion.artifactRel, marker: active.completion.marker }
            : active.completion.kind === 'red'
              ? { kind: 'red', resultRel: active.completion.resultRel }
              : active.completion.kind === 'green'
                ? { kind: 'green', resultRel: active.completion.resultRel }
                : null,
        ...(active.instruction !== undefined ? { instruction: active.instruction } : {}),
        ...(active.inputs !== undefined ? { inputs: active.inputs } : {}),
        ...briefFor(active),
      });
    },
    inject: (prompt, opts) => {
      // Clear the prior turn's done-signal at the PROMPT inject (not the preamble): any earlier and a
      // completion arriving during the boundary drain would be dropped (§27.12/D46 parallel).
      if (!opts?.preamble && active) clearTurnDone(active.repoDir, APP_TURN_DONE_SUBDIR);
      deps.inject(prompt);
    },
    hostedAgent: () => deps.hostedAgent(),
    completionShortfall,
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
      const errored = active;
      hook(() => deps.loopRunEvent?.(errored.repoDir, errored.stepId, errored.turnKey, 'error'));
      deps.emitError(reason);
    },
    resumeStalled: () => {
      if (!active) return;
      persist('working');
      deps.audit(active.repoDir, `§27 turn ${active.turnKey} resumed after a stall (done-signal)`, 0);
    },
    onComplete: (turnKey) => {
      if (!active) return;
      if (active.phase === 'work') {
        // §28.5.3/§28.8.3 — a completed GREEN work turn records its (non-blocking) changed-test flag from the
        // gate's stash before advancing.
        drainChangedTestsStash(active);
        // §27.3 — advance straight into the review turn with no transient work-complete state, so a relaunch
        // never mistakes a mid-chain crash for a finished loop.
        deps.audit(active.repoDir, `§27 work turn ${turnKey} complete`, 0);
        enterReview(active, FIRST_ROUND);
        return;
      }
      if (active.phase === 'review') {
        // §28.5.3/§28.8.3 — a completed GREEN/REFACTOR round records its (non-blocking) changed-test flag from the
        // probe's stash before chaining the consolidator. A plain review round has no stash (no probe ran).
        if (active.completion.kind === 'green-report' || active.completion.kind === 'refactor-report') drainChangedTestsStash(active);
        // §27.6/AC1 — the review-and-fix round completed; chain the consolidator with no transient complete
        // state (so a relaunch never mistakes a mid-chain crash for a finished loop).
        deps.audit(active.repoDir, reviewRoundAuditCmd('complete', active.round), 0);
        const report = deps.readArtifact(active.reportPath);
        const reviewed = active;
        hook(() => deps.loopRunEvent?.(reviewed.repoDir, reviewed.stepId, reviewed.turnKey, { roundReport: report }));
        startConsolidate(active);
        return;
      }
      // §27.6 — the consolidator produced a well-formed verdict; branch on it (with the failed-lens guard and
      // the armed-interrupt override).
      finishConsolidate(active);
    },
    noteSettle: () => deps.noteSettle(),
  });

  const start = (turn: ActiveAppTurn, defer = false): void => {
    active = turn;
    persist('working');
    deps.audit(turn.repoDir, `§27 work turn ${turn.turnKey} boundary: ${turn.boundaryCmd}`, null);
    // §B.20a — with `defer`, ACCEPT the turn but hold its request for a caller trigger: the coordinator fires
    // it from the skill injection's completion so the two never share the input line (AC10/CWE-74). The
    // `awaitingTrigger` flag makes canEnter/enter treat the turn as in-flight across the gap (§B.5 item 6(b)).
    if (defer) {
      awaitingTrigger = true;
      return;
    }
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
    // §28.5.3 — a REFACTOR loop's round writes a round-keyed phase-result file; resolve its location from the
    // ONE resolver — the compose threads the rel, the R5 gate reads the path. An unresolvable location is a
    // routable error (return null), never a fabricated pass — exactly as an unresolvable report location above.
    let completion: Extract<ActiveAppTurn, { phase: 'review' }>['completion'];
    if (r.def.work.completion === 'refactor') {
      const res = deps.resolveRefactorResultLocation(ctx.repoDir, round);
      if (!res) return null;
      completion = { kind: 'refactor-report', resultPath: res.abs, resultRel: res.rel };
    } else if (r.def.work.completion === 'green') {
      completion = { kind: 'green-report' };
    } else {
      completion = { kind: 'report' };
    }
    const full = reviewRoster(r.def);
    const reviewers = chosenRoster ? full.filter((e) => chosenRoster.includes(e.persona)) : full;
    const subject = r.def.work.completion === undefined ? completionArtifact(r.def) : null;
    const inputs = chainFor(ctx.repoDir, ctx.stepId, r.def, { kind: 'reconstruct', ids: recordedCarry(ctx.repoDir, ctx.stepId, readAppLoopState(ctx.repoDir)) });
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
      polish: r.def.report.polish,
      reportPath: loc.abs,
      reportRel: loc.rel,
      completion,
      ...(chosenRoster ? { chosenRoster } : {}),
      ...(feedback !== undefined ? { feedback } : {}),
      ...(subject !== null ? { subjectRel: subject.rel } : {}),
      ...(inputs.length > 0 ? { inputs } : {}),
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
  const routeConsolidateToGate = (
    turn: Extract<ActiveAppTurn, { phase: 'consolidate' }>,
    verdict: ConsolidatorVerdict,
    reason: string | undefined,
    roster: string[],
    cause: GateCause = 'verdict',
  ): void => {
    turn.verdict = verdict;
    turn.verdictReason = verdictCarriesReason(verdict) ? reason : undefined;
    turn.chosenRoster = roster.length > 0 ? roster : undefined;
    // §27.9.1 N9b.5(e) — before the persist, so the view it pushes already reads the engine's decision.
    hook(() => deps.gateReaching?.(turn.repoDir, turn.stepId, turn.turnKey, verdict, cause));
    if (!persist('complete')) {
      hook(() => deps.gateNotReached?.(turn.repoDir, turn.stepId, turn.turnKey));
      // §27.12c/CWE-703/755 — the `complete` write failed (ENOSPC/EPERM/a planted symlink), so the disk still
      // holds the pre-terminal `working`. This is the ONE transition whose purpose is to summon the human (a
      // `stop for a human`/`clean` gate); nulling liveError and leaving `working` would silently strand them.
      // Hold a live turn-error so the view keeps the retry/terminate route-out reachable, mirroring writeError.
      const saveFailReason = 'the consolidator finished but its verdict could not be saved — retry';
      refuseRouteOut('turn-error', saveFailReason, turn.round);
      return;
    }
    deps.audit(turn.repoDir, consolidateAuditCmd('complete', turn.round, verdict), 0);
    hook(() => deps.gateReached?.(turn.repoDir, turn.stepId, turn.turnKey));
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
    const arm = deps.interruptArmed ? deps.interruptArmed(turn.repoDir, turn.stepId) : readArmedInterrupt(turn.repoDir)?.step === turn.stepId ? 'set' : 'absent';
    if (arm === 'set') {
      if (deps.consumeInterrupt) deps.consumeInterrupt(turn.repoDir);
      else clearInterrupt(turn.repoDir);
      deps.audit(turn.repoDir, consolidateAuditCmd('interrupt', turn.round, verdict), 0);
      routeConsolidateToGate(turn, verdict, reason, roster, 'interrupt');
      return;
    }

    // §27.9.1 N9b.6(h)
    if (arm === 'unreadable' && verdict === 'another round') {
      routeConsolidateToGate(turn, verdict, reason, roster, 'arm-unreadable');
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
    // §28.5.3 — surface the injected machine completion predicates; S3/S4's gate calls through this.
    completionPredicates: deps.completionPredicates,
    canEnter() {
      return runner.state() !== 'in-flight' && !awaitingTrigger;
    },
    triggerDeferredTurn() {
      if (!awaitingTrigger || !active) return;
      awaitingTrigger = false;
      // §B.5 item 4b — the chained arm: re-arm quiescence and wait for a fresh settle, never inject on the
      // stale quiet the just-submitted skill left behind.
      runner.requestTurn(active.turnKey, { preamble: active.boundaryCmd, forceChained: true });
    },
    cancelDeferredTurn() {
      if (!awaitingTrigger) return;
      // §B.5 item 6(a) — the deadline lapsed with no completion signal: drop the accepted-but-unrequested
      // turn so the runner is free, then the coordinator reverts the flow step. No request was ever issued.
      awaitingTrigger = false;
      active = null;
    },
    enter(repoDir, loopName, stepId, entry, opts) {
      if (runner.state() === 'in-flight' || awaitingTrigger) return 'busy';
      const r = deps.resolveDef(repoDir, loopName);
      if (!r.ok) return 'unresolved';
      // §27.9/AC6 — a fresh clean-slate work turn owns no prior stand-down: clear any stale polish so an
      // abandoned one (Terminated rather than approved, or a failed clear) cannot resurrect the polish view when
      // this step reaches its gate again. Relaunch reconstructs via resume(), not enter(), so AC11 is untouched.
      // Best-effort, exactly as the approve-path clear (appGateDecision): a throw (polish.yaml swapped for a
      // directory → EISDIR that rmSync's `force` does not swallow) must NEVER abort the entry — else the step is
      // committed with a work turn that never starts and cannot restart (re-entry would re-throw). A residual
      // stand-down still narrows to approve (loopViewV2), never strands the operator.
      try {
        deps.clearPolish(repoDir);
      } catch (e) {
        deps.audit(repoDir, `§27 ${loopName} ${stepId} enter clear-polish failed: ${e instanceof Error ? e.message : String(e)}`, 1);
      }
      // §28.4 D2/#123 — a RED phase entry starts a fresh slice's test-state baseline: clear any stale same-branch
      // baseline (a prior phase/slice, or a prior redo of this slice), so the next GREEN/refactor frozen check
      // BLOCKS (fail toward firing) unless THIS slice's RED records its own — never stale-matches. Fires on every
      // RED entry (first, loop-back, and human back-to-RED), which is once per slice's RED via enterAppLoop's
      // §24.2.3-T3 entry action; relaunch resumes via resume(), not enter(), so a mid-slice relaunch never clears.
      // Best-effort like clearPolish: a throw (unresolvable loop area) must never abort the entry.
      if (r.def.work.completion === 'red') {
        try {
          deps.clearBaseline(repoDir);
        } catch (e) {
          deps.audit(repoDir, `§28 ${loopName} ${stepId} enter clear-baseline failed: ${e instanceof Error ? e.message : String(e)}`, 1);
        }
      }
      let ids: string[] = [];
      let inputs: ChainedInput[] = [];
      if (entry === 'chain-advance') {
        inputs = chainFor(repoDir, stepId, r.def, { kind: 'advance' });
        ids = inputs.map((i) => i.id);
      } else if (entry === 're-entry') {
        ({ ids, inputs } = reEnter(repoDir, stepId, r.def, readAppLoopState(repoDir)));
      }
      setCarry(repoDir, stepId, ids);
      start(activeTurnFor(repoDir, loopName, stepId, r.def, { inputs, ...(opts?.slice !== undefined ? { slice: opts.slice } : {}) }), opts?.deferRequest === true);
      return 'entered';
    },
    onInjectable() {
      runner.onInjectable();
    },
    onDoneSignal() {
      const a = active;
      if (a?.completion.kind === 'red') {
        // §28.5.3 / §28 Option C — the RED machine ground truth needs an async git check; compute it, then
        // re-enter the SYNC runner with the pre-evaluated gate. Guards: `asyncGatePendingFor` dedupes a duplicate
        // (un-debounced) done-signal while a gate is pending; a stall during the await leaves the turn resumable,
        // so the late gate still resolves it unless the operator accepted or terminated it meanwhile (runner
        // guard); and a turn that changed under us (a retry rebuilt `active`) is ignored (identity guard).
        if (asyncGatePendingFor === a) return;
        asyncGatePendingFor = a;
        void redAsyncGate(a).then((gate) => {
          asyncGatePendingFor = null; // cleared before re-checking, so a genuine retry's real signal spawns a fresh gate
          if (active === a) runner.onDoneSignal(gate);
        });
      } else if (a?.completion.kind === 'green') {
        // §28.5.3 — the GREEN gate shares the same async machinery (dedup + identity + runner-state guards) and
        // additionally stashes the non-blocking frozen paths for onComplete. The stash write sits INSIDE the
        // `active === a` guard so a stale gate resolving after a retry cannot clobber the fresh turn's flag.
        if (asyncGatePendingFor === a) return;
        asyncGatePendingFor = a;
        void greenAsyncGate(a).then(({ gate, changedTests }) => {
          asyncGatePendingFor = null;
          if (active === a) {
            // If the operator accepted or terminated `a` while the gate awaited, `runner.onDoneSignal(gate)` below
            // no-ops, so onComplete never drains this stash; the next work turn's onComplete clears it.
            stashChangedTests(a, changedTests);
            runner.onDoneSignal(gate);
          }
        });
      } else if (a?.phase === 'review' && a.completion.kind === 'refactor-report') {
        // §28.5.3 — the REFACTOR round gates on the exit-direction (blocking, §28.5.3:124) AND runs the frozen
        // check as a non-blocking side probe whose paths are stashed inside the `active === a` guard, so a stale
        // gate/probe cannot record against a fresh turn (IT-REFAC-8/-8b). Same dedup guard as the GREEN gate.
        if (asyncGatePendingFor === a) return;
        asyncGatePendingFor = a;
        void Promise.all([refactorAsyncGate(a), reviewRoundFrozenProbe(a)]).then(([gate, changedTests]) => {
          asyncGatePendingFor = null;
          if (active === a) {
            stashChangedTests(a, changedTests);
            runner.onDoneSignal(gate);
          }
        });
      } else if (a?.phase === 'review' && a.completion.kind === 'green-report') {
        // §28.5.3
        if (asyncGatePendingFor === a) return;
        asyncGatePendingFor = a;
        void reviewRoundFrozenProbe(a).then((changedTests) => {
          asyncGatePendingFor = null;
          if (active === a) {
            stashChangedTests(a, changedTests);
            runner.onDoneSignal();
          }
        });
      } else {
        runner.onDoneSignal();
      }
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
          // The one view push follows the accepted fact, so the stop is never shown without its halt (§27.9.1).
          if (!persist('complete', undefined, false)) {
            refuseRouteOut('turn-error', saveFailReason, round);
            return;
          }
          runner.release();
          deps.audit(repoDir, successAudit, 0);
          hook(() => deps.loopRunEvent?.(repoDir, stepId, turnKey, 'accepted'));
          deps.onViewChanged();
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
          // §28.5.3/§28.5.6 — a REFACTOR round's accept relaxes report WELL-FORMEDNESS only (report presence is
          // guaranteed above), NEVER the machine clauses: it refuses an absent result (presence, never relaxed),
          // a non-`passed` result, and a non-zero test exit (the exit-direction, §28.5.3:124 — machine ground
          // truth, not a human-override target, the RED/GREEN twin), keeping AC2 route-invariant. When it
          // finalizes it records the non-blocking flag on this route (accept has no onComplete to drain the stash).
          if (active.completion.kind === 'refactor-report') {
            const result = deps.readArtifact(active.completion.resultPath);
            if (result === null) {
              refuseRouteOut('turn-error', 'the refactor round has no result to accept — retry or terminate', active.round);
              return;
            }
            if (deps.completionPredicates.resultOutcome(result) !== REFACTOR_COMPLETING_OUTCOME) {
              refuseRouteOut('turn-error', "the refactor round's tests are not passing — retry or terminate", active.round);
              return;
            }
            const a = active;
            void Promise.all([refactorAsyncGate(a), reviewRoundFrozenProbe(a)]).then(([gate, changedTests]) => {
              if (active !== a) return; // a retry/terminate changed the turn under the await
              if (!gate.ok) {
                refuseRouteOut('turn-error', gate.reason, a.round);
                return;
              }
              if (changedTests !== null) recordChangedTestsFlag(a, changedTests);
              acceptFinalize('the refactor round was accepted but could not be saved — retry or terminate', reviewRoundAuditCmd('accept', a.round), a.round);
            });
            return;
          }
          if (active.completion.kind === 'green-report') {
            const a = active;
            void reviewRoundFrozenProbe(a).then((changedTests) => {
              if (active !== a) return; // a retry/terminate changed the turn under the await
              if (changedTests !== null) recordChangedTestsFlag(a, changedTests);
              acceptFinalize('the review round was accepted but could not be saved — retry or terminate', reviewRoundAuditCmd('accept', a.round), a.round);
            });
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
        // §28.5.3 / AC2 — a RED work turn's accept must satisfy BOTH the sync clause (result present +
        // failed-assertion) AND the async machine gate (a test was added, exit ≠ 0 where recoverable). §28.5.6
        // assigns the human backstop to the assertion-vs-compile REASON only; "a test was added" is the machine
        // half, so accept may NOT relax it — AC2 ("adds no test file → does not complete") is unqualified by
        // route. Compute the gate async (fire-and-forget); the turn stays in `error` during the await, so a
        // concurrent retry/terminate rebuilds `active` and the identity guard skips the stale finalize.
        if (active.completion.kind === 'red') {
          const a = active;
          void redAsyncGate(a).then((gate) => {
            if (active !== a) return; // a retry/terminate changed the turn under the await
            if (!completionSatisfied()) return; // the sync clause fails (missing/malformed result) — Retry re-runs
            if (!gate.ok) {
              refuseRouteOut('turn-error', gate.reason);
              return;
            }
            acceptFinalize('the work turn was accepted but could not be saved — retry or terminate', `§27 work turn ${turnKey} accepted (RED gate satisfied)`);
          });
          return;
        }
        // §28.5.3 / AC3 — a GREEN work turn's accept mirrors the RED accept: it requires BOTH the sync clause
        // (result present + passed + built) AND the async gate (baseline present+branch-matched, exit-direction).
        // It ALSO records the non-blocking changed-test flag on this override route (the done-signal route records
        // it via onComplete; the accept route has no onComplete, so it records here — else an operator-accepted
        // GREEN turn with a changed test would complete with the flag never written).
        if (active.completion.kind === 'green') {
          const a = active;
          void greenAsyncGate(a).then(({ gate, changedTests }) => {
            if (active !== a) return; // a retry/terminate changed the turn under the await
            if (!completionSatisfied()) return; // the sync clause fails (missing/malformed/not passed+built)
            if (!gate.ok) {
              refuseRouteOut('turn-error', gate.reason);
              return;
            }
            if (changedTests !== null) recordChangedTestsFlag(a, changedTests);
            acceptFinalize('the work turn was accepted but could not be saved — retry or terminate', `§27 work turn ${turnKey} accepted (GREEN gate satisfied)`);
          });
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
      // §27.10 — after a relaunch the route-out handler reconstructs this turn first (`index.ts`, and only
      // when no live turn for this repo holds), and that reconstruction announces nothing. Retry is the
      // operator asking the turn to RUN, so rebuild it from ONE fresh def resolution: an input that vanished
      // since is surfaced rather than dropped from the INPUTS block in silence, one that came back is
      // carried, and the recipe, boundary and completion contract cannot be a revision older than the
      // inputs they are graded beside. An unresolvable def refuses the retry exactly as Accept refuses.
      if (active.phase === 'work') {
        const rr = deps.resolveDef(repoDir, active.loopName);
        if (!rr.ok) {
          // Neutralize to the same unresolved shape `resume` builds so the sibling Accept lever honours the
          // same def-resolves precondition — a `commits`/present-`file` turn otherwise stays acceptable
          // (completionSatisfied() unconditionally true) and fabricates a pass on a def that no longer
          // resolves. A later retry with a resolvable def rebuilds via `activeTurnFor` from the preserved id.
          active = unresolvedWorkTurn({
            repoDir,
            loopName: active.loopName,
            stepId,
            turnKey,
            ...(active.instruction !== undefined ? { instruction: active.instruction } : {}),
          });
          refuseRouteOut('def-unresolvable', 'the bound def no longer resolves — retry or terminate');
          return;
        }
        const { inputs } = reEnter(repoDir, stepId, rr.def, readAppLoopState(repoDir));
        active = activeTurnFor(repoDir, active.loopName, stepId, rr.def, {
          ...(active.instruction !== undefined ? { instruction: active.instruction } : {}),
          inputs,
        });
      }
      persist('working');
      const retryAudit =
        active.phase === 'review'
          ? reviewRoundAuditCmd('retry', active.round)
          : active.phase === 'consolidate'
            ? consolidateAuditCmd('retry', active.round)
            : `§27 work turn ${turnKey} retry`;
      deps.audit(repoDir, retryAudit, null);
      hook(() => deps.loopRunEvent?.(repoDir, stepId, turnKey, 'retried'));
      runner.requestTurn(turnKey, { preamble: active.boundaryCmd });
    },
    requestChanges(repoDir, stepId, turnKey, feedback) {
      if (runner.state() === 'in-flight') return false; // §27.2 — never interleave a second turn
      // §27.9/AC6 — while polish stands the orchestrator down for THIS step, no lever may re-enter a turn: the
      // operator owns the keyboard until approve ends it. A request-changes racing the stand-down is refused.
      if (deps.polishActive(repoDir, stepId)) return false;
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
      // §27.9/AC6 — polish stands the orchestrator down for THIS step: a redo racing the stand-down is refused.
      if (deps.polishActive(repoDir, stepId)) return false;
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
      const { ids, inputs } = reEnter(repoDir, stepId, r.def, state);
      setCarry(repoDir, stepId, ids);
      start(activeTurnFor(repoDir, state.loop, stepId, r.def, { instruction, inputs }));
      return true;
    },
    resume(repoDir) {
      const state = readAppLoopState(repoDir);
      if (!state) return;
      // §27.10 — restore the entry's record before any phase of this step persists again, or the first write
      // after a relaunch rewrites the document without it and the carry is gone for good.
      const reconstructIds = recordedCarry(repoDir, state.step, state);
      setCarry(repoDir, state.step, reconstructIds);
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
        ? activeTurnFor(repoDir, state.loop, state.step, r.def, {
            instruction: state.instruction,
            inputs: chainFor(repoDir, state.step, r.def, { kind: 'reconstruct', ids: reconstructIds }),
          })
        : unresolvedWorkTurn({ repoDir, loopName: state.loop, stepId: state.step, turnKey: state.turnKey, ...(state.instruction !== undefined ? { instruction: state.instruction } : {}) });
      makeRoutable();
    },
    activeTurnKey: () => active?.turnKey ?? null,
    activeRepoDir: () => active?.repoDir ?? null,
    releaseStalledTurn: (repoDir) => {
      if (active?.repoDir === repoDir) runner.release();
    },
    liveErrorFor: (repoDir) => {
      if (!liveError || liveError.repoDir !== repoDir) return null;
      const { kind, loop, step, turnKey, reason, round } = liveError;
      return { kind, loop, step, turnKey, reason, ...(round !== undefined ? { round } : {}) };
    },
  };
}
