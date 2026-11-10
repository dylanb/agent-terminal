// §27.9.1 — the gate controller: who decides an `auto` step's gate.

import type { ConsolidatorVerdict } from '../shared/consolidatorOutput';
import type { FlowAutoGateView } from '../shared/ipc';
import type { FlowLike } from '../shared/audit';
import { autoHaltAuditCmd } from '../shared/audit';
import { failedEffectNotice, type AutoHaltReason, type FailedEffectState } from '../shared/gateAuthority';
import { composeGateQuestion, type GateStop, type StalledTurn } from '../shared/gateQuestion';
import { displaySafeEcho, MAX_ECHOED_REASON_LENGTH } from '../shared/controlChars';
import { reportNeedsAHuman } from '../shared/roundReport';
import type { FlowDefinition } from './flow';
import type { ApproveClaim, ApproveDecider, GateApproveOutcome } from './appGateDecision';
import type { AutoGateViewFor } from './loopViewV2';
import type { DispositionRead } from './resolveRunDefinition';
import type { LoopDefV2Result } from './loopDefV2';
import { clearInterrupt, type FlagProbe, isPolishActiveForStep, probeArmedInterrupt, readAppLoopState, readArmedInterrupt, recordChangedTests } from './appLoopState';
import { approveTimeFrozenCheck, type ApproveTimeFrozenCheck } from './frozenTests';
import { recordRedTestChanges } from './redTestChanges';
import { inProgressRunIdentity, readGateRunState, sameRun, writeGateRunState, type RelaunchHalt, type RunIdentity } from './gateRunState';
import { errMsg } from './errno';

export interface DefResolution {
  completion?: 'red' | 'green' | 'refactor';
  frozenCheck?: true;
}

export interface StartRun {
  definition: FlowDefinition;
  binding?: DispositionRead;
}

export type GateCause = 'verdict' | 'interrupt' | 'arm-unreadable';
export type LoopRunEvent = 'error' | { resumableStall: { doneRelPath: string } } | 'retried' | 'accepted' | { roundReport: string | null };
export type EngineApprove = (repoDir: string, step: string, turnKey: string, decider: ApproveDecider) => Promise<GateApproveOutcome>;
export interface AutoGateTimer {
  readonly id: number;
}

export interface AutoGateDeps {
  audit: (repoDir: string, cmd: string, exit: number | null) => void;
  resolveDef: (repoDir: string, loop: string) => DefResolution | null;
  /** The in-progress run's flow, resolved from the binding its Start recorded; null when it cannot be (§27.9.1 N9b.8). */
  currentRun: (repoDir: string) => StartRun | null;
  runInProgressAt: (repoDir: string, step: string) => boolean;
  onViewChanged: (repoKey: string) => void;
  /** §27.9.1 N9b.5(d) — the run-end report of a failed effect. */
  emitError: (repoDir: string, reason: string) => void;
  setTimer: (cb: () => void, ms: number) => AutoGateTimer;
  clearTimer: (handle: AutoGateTimer) => void;
  decisionBoundMs: number;
  /** §27.9.1 N9b.10 */
  askAgentWhy: (question: string) => void;
  /** §27.9.1 N9b.10 */
  withdrawAgentQuestion: () => void;
  currentSlice: (repoDir: string) => number;
}

export interface AutoGate {
  bindAtStart(repoKey: string, run: StartRun, startedAt: number): void;
  discardStart(repoKey: string): void;
  commitStart(repoKey: string): void;
  endRun(repoKey: string): void;
  beginLoopRun(repoKey: string, step: string): void;
  gateReaching(repoDir: string, step: string, turnKey: string, verdict: ConsolidatorVerdict, cause: GateCause): void;
  gateReached(repoDir: string, step: string, turnKey: string): void;
  gateNotReached(repoDir: string, step: string, turnKey: string): void;
  loopRunEvent(repoDir: string, step: string, turnKey: string, event: LoopRunEvent): void;
  interruptArmed(repoDir: string, step: string): FlagProbe['kind'];
  consumeInterrupt(repoDir: string): void;
  /** §27.9.1 N9b.5(d)/(e) — a human decision attempt or manual Advance at `step`; call the result with whether it landed. */
  humanDecision(repoKey: string, step: string, turnKey: string | null): (landed: boolean) => void;
  flowTransitioned(repoKey: string, after: FlowLike): void;
  attachApprove(approve: EngineApprove): void;
  isAutoRun(repoKey: string): boolean;
  autoGateViewFor: AutoGateViewFor;
}

/** The `DefResolution` the controller reads off a def resolution. */
export function defResolutionOf(r: LoopDefV2Result): DefResolution | null {
  if (!r.ok) return null;
  return {
    ...(r.def.work.completion ? { completion: r.def.work.completion } : {}),
    ...(r.def.work.frozenCheck ? { frozenCheck: true as const } : {}),
  };
}

type Reason = { reason: AutoHaltReason; detail?: string };

const ARM_UNREADABLE = 'the interrupt arm could not be read';

interface GateKey {
  step: string;
  turnKey: string;
  gateSeq: number;
}

interface Deciding extends GateKey {
  humanAttempted: boolean;
  approveStarted: boolean;
  claimed: boolean;
  abandoned: boolean;
  ended: boolean;
  checking: Reason[] | null;
  check: AbortController;
  timer: AutoGateTimer;
}

interface LoopRun {
  step: string;
  endedInError: boolean;
  acceptedFailure: boolean;
  needsAHuman: boolean;
  recorded: Set<AutoHaltReason>;
}

interface AutoRun {
  identity: RunIdentity;
  /** The last write of the persisted gate state did not land (§27.9.1 N9b.5(b)). */
  stateUnsaved: boolean;
  humanDecisions: number;
  /** The last flow transition reached the run's end (§27.9.1 N9b.5(d)). */
  atRunEnd: boolean;
  steps: FlowDefinition['steps'];
  bound: Map<string, { authority: 'auto' | 'human'; loop: string }>;
  loopRun: LoopRun | null;
  failedEffect: { state: FailedEffectState; detail: string; reported: boolean } | null;
  relaunchHalt: RelaunchHalt | null;
  gateSeq: number;
  pendingGate: (GateKey & { verdict: ConsolidatorVerdict; cause: GateCause }) | null;
  deciding: Deciding | null;
  hung: GateKey | null;
  haltShown: (GateKey & { reasons: Reason[] }) | null;
  asked: GateKey | null;
}

const sameGate = (a: GateKey | null, step: string, turnKey: string, gateSeq: number): boolean =>
  a !== null && a.step === step && a.turnKey === turnKey && a.gateSeq === gateSeq;

const isFrozenCheckCompletion = (c: DefResolution['completion']): boolean => c === 'green' || c === 'refactor';

const bestEffort = (call: () => void): void => {
  try {
    call();
  } catch (e) {
    void errMsg(e);
  }
};

export function createAutoGate(deps: AutoGateDeps): AutoGate {
  const runs = new Map<string, AutoRun>();
  const replaced = new Map<string, AutoRun | undefined>();
  let approve: EngineApprove | null = null;

  const push = (repoKey: string): void => bestEffort(() => deps.onViewChanged(repoKey));

  /** §27.9.1 N9b.5(d) — written before the view that shows the change is pushed. */
  const persist = (repoDir: string, run: AutoRun): void => {
    if (!isAuto(run)) return;
    const lr = run.loopRun;
    try {
      writeGateRunState(repoDir, {
        run: run.identity,
        loopRun: lr === null ? null : { step: lr.step, endedInError: lr.endedInError, acceptedFailure: lr.acceptedFailure, needsAHuman: lr.needsAHuman, recorded: [...lr.recorded] },
        failedEffect: run.failedEffect === null ? null : { ...run.failedEffect },
        relaunchHalt: run.relaunchHalt === null ? null : { ...run.relaunchHalt },
      });
      run.stateUnsaved = false;
    } catch (e) {
      run.stateUnsaved = true;
      bestEffort(() => deps.emitError(repoDir, `The run's gate state could not be saved: ${errMsg(e)}`));
    }
  };

  const isAuto = (run: AutoRun): boolean => [...run.bound.values()].some((b) => b.authority === 'auto');
  const honouredAuto = (run: AutoRun, step: string): boolean => run.bound.get(step)?.authority === 'auto';

  const clearDeciding = (run: AutoRun): void => {
    if (run.deciding === null) return;
    deps.clearTimer(run.deciding.timer);
    run.deciding.check.abort();
    run.deciding = null;
  };

  const consume = (repoDir: string): string | null => {
    try {
      clearInterrupt(repoDir);
      return null;
    } catch (e) {
      return `the interrupt could not be cleared: ${errMsg(e)}`;
    }
  };

  const consumeOrReport = (repoDir: string): void => {
    const failed = consume(repoDir);
    if (failed !== null) bestEffort(() => deps.emitError(repoDir, failed));
  };

  const clearFailedAt = (run: AutoRun, step: string): boolean =>
    run.haltShown?.step === step && run.haltShown.reasons.some((r) => r.reason === 'interrupt-armed' && r.detail !== undefined);

  /** §27.9.1 N9b.10 */
  const askWhy = (run: AutoRun, key: GateKey, stop: GateStop): void => {
    if (sameGate(run.asked, key.step, key.turnKey, key.gateSeq)) return;
    run.asked = { step: key.step, turnKey: key.turnKey, gateSeq: key.gateSeq };
    bestEffort(() => deps.askAgentWhy(composeGateQuestion(stop)));
  };

  const withdrawQuestion = (): void => bestEffort(() => deps.withdrawAgentQuestion());

  /** One engine-decided entry naming every reason (§27.9.1 N9b.9), then the gate is the human's. */
  const halt = (repoDir: string, run: AutoRun, key: GateKey, held: Reason[], opts: { write: boolean; ask?: boolean; resume?: StalledTurn } = { write: true }): void => {
    const failed = held.some((r) => r.reason === 'interrupt-armed') ? consume(repoDir) : null;
    const reasons = failed === null ? held : held.map((r) => (r.reason === 'interrupt-armed' ? { ...r, detail: failed } : r));
    const lr = run.loopRun;
    const recordedAlready = lr !== null && lr.step === key.step && reasons.every((r) => lr.recorded.has(r.reason));
    if (opts.write && !recordedAlready) bestEffort(() => deps.audit(repoDir, autoHaltAuditCmd(reasons), 0));
    run.haltShown = { step: key.step, turnKey: key.turnKey, gateSeq: key.gateSeq, reasons };
    if (sameGate(run.deciding, key.step, key.turnKey, key.gateSeq)) clearDeciding(run);
    push(repoDir);
    if (opts.ask !== false) askWhy(run, key, { kind: 'halted', step: key.step, reasons, ...(opts.resume === undefined ? {} : { resume: opts.resume }) });
  };

  const setFailedEffect = (repoDir: string, run: AutoRun, detail: string): void => {
    run.failedEffect = { state: 'set', detail, reported: false };
    persist(repoDir, run);
    if (run.atRunEnd) reportRunEnd(repoDir, run);
  };

  /** §27.9.1 N9b.5(d) — a run never ends silently over a failed effect. */
  const reportRunEnd = (repoDir: string, run: AutoRun): void => {
    const marker = run.failedEffect;
    if (marker === null || marker.reported || run.humanDecisions > 0) return;
    marker.reported = true;
    persist(repoDir, run);
    bestEffort(() => deps.emitError(repoDir, failedEffectNotice(marker.state, marker.detail)));
    bestEffort(() => deps.audit(repoDir, autoHaltAuditCmd([{ reason: marker.state === 'set' ? 'failed-effect' : 'engine-input-missing', detail: marker.detail }]), 0));
  };

  /** §27.9.1 N9b.5(d) — `done`, or a step after which the run has no loop step left. */
  const reachedRunEnd = (run: AutoRun, after: FlowLike): boolean => {
    if (after.status === 'done') return true;
    if (after.status !== 'in_progress') return false;
    const at = run.steps.findIndex((s) => s.id === after.stepName);
    return at >= 0 && run.steps.slice(at).every((s) => s.kind !== 'loop');
  };

  /** §27.9.1 N9b.6(a)–(c), (h)–(i) */
  const evaluate = (repoDir: string, run: AutoRun, step: string, cause: GateCause): Reason[] => {
    const reasons: Reason[] = [];
    const lr = run.loopRun !== null && run.loopRun.step === step ? run.loopRun : null;
    if (lr === null || lr.needsAHuman) reasons.push({ reason: 'needs-a-human' });
    if (lr !== null && (lr.endedInError || lr.acceptedFailure)) reasons.push({ reason: 'loop-error' });
    const arm = probeArmedInterrupt(repoDir).kind;
    if (cause === 'interrupt' || arm === 'set') reasons.push({ reason: 'interrupt-armed' });
    const marker = run.failedEffect;
    if (marker?.state === 'unknown') reasons.push({ reason: 'engine-input-missing', detail: marker.detail });
    else if (run.stateUnsaved) reasons.push({ reason: 'engine-input-missing', detail: 'the run\'s gate state could not be saved' });
    else if (arm === 'unreadable' || cause === 'arm-unreadable') reasons.push({ reason: 'engine-input-missing', detail: ARM_UNREADABLE });
    else if (lr === null) reasons.push({ reason: 'engine-input-missing' });
    if (marker?.state === 'set') reasons.push({ reason: 'failed-effect' });
    return reasons;
  };

  const verdictReason = (verdict: ConsolidatorVerdict): AutoHaltReason | null => {
    switch (verdict) {
      case 'clean':
        return null;
      case 'stop for a human':
        return 'stop-for-a-human';
      case 'another round':
        return 'interrupt-armed';
    }
  };

  const onBound = (repoDir: string, run: AutoRun, d: Deciding): void => {
    if (runs.get(repoDir) !== run || run.deciding !== d) return;
    if (d.checking !== null && (d.humanAttempted || runStateLeft(repoDir, d))) {
      d.check.abort();
      standDown(repoDir, run);
      return;
    }
    if (d.claimed) {
      run.hung = { step: d.step, turnKey: d.turnKey, gateSeq: d.gateSeq };
      setFailedEffect(repoDir, run, 'the engine approve did not settle within its bound');
      push(repoDir);
      return;
    }
    d.abandoned = true;
    const reason: Reason = d.approveStarted
      ? { reason: 'approve-not-persisted', detail: 'the engine approve did not settle within its bound' }
      : d.checking !== null
        ? { reason: 'frozen-check-unavailable', detail: 'the approve-time frozen check did not settle within its bound' }
        : { reason: 'engine-input-missing', detail: 'the gate could not be evaluated' };
    halt(repoDir, run, d, [...(d.checking ?? []), reason]);
  };

  /** §27.9.1 N9b.6(l) — a gate the run moved on from gets the marker alone; an unreadable probe counts as pending. */
  const stillPending = (repoDir: string, d: Deciding): boolean => {
    try {
      return deps.runInProgressAt(repoDir, d.step);
    } catch {
      return true;
    }
  };

  const settle = (repoDir: string, run: AutoRun, d: Deciding, outcome: GateApproveOutcome | { kind: 'threw'; reason: string }): void => {
    if (d.ended || runs.get(repoDir) !== run) return;
    const wasHung = sameGate(run.hung, d.step, d.turnKey, d.gateSeq);
    if (wasHung) run.hung = null;
    if (run.deciding !== d) {
      if (wasHung) push(repoDir);
      return;
    }
    const detail = (text: string): string => displaySafeEcho(text, MAX_ECHOED_REASON_LENGTH);
    switch (outcome.kind) {
      case 'advanced':
        if (outcome.effectFailures.length > 0) setFailedEffect(repoDir, run, detail(outcome.effectFailures.join('; ')));
        clearDeciding(run);
        push(repoDir);
        return;
      case 'preview-raised':
        halt(repoDir, run, d, [{ reason: 'epic-promotion' }], { write: false });
        return;
      case 'blocked':
        halt(repoDir, run, d, [{ reason: 'epic-promotion' }]);
        return;
      case 'refused':
        halt(repoDir, run, d, [{ reason: 'approve-not-persisted', detail: detail(outcome.reason) }]);
        return;
      case 'accept-failed':
        halt(repoDir, run, d, [{ reason: 'approve-not-persisted', detail: detail(outcome.reason) }], { write: false });
        return;
      case 'abandoned':
        halt(repoDir, run, d, [{ reason: 'approve-not-persisted', detail: 'the engine approve did not settle within its bound' }]);
        return;
      case 'refused-late':
        halt(repoDir, run, d, [...outcome.reasons.map((reason) => ({ reason })), { reason: 'approve-not-persisted', detail: 'the gate changed while the engine decided' }]);
        return;
      case 'run-ended':
      case 'stood-down':
        clearDeciding(run);
        push(repoDir);
        return;
      case 'threw':
        setFailedEffect(repoDir, run, detail(outcome.reason));
        if (!stillPending(repoDir, d)) {
          clearDeciding(run);
          push(repoDir);
          return;
        }
        halt(repoDir, run, d, [{ reason: 'approve-not-persisted', detail: detail(outcome.reason) }]);
        return;
      case 'held':
        halt(repoDir, run, d, [{ reason: 'approve-not-persisted', detail: 'the approve was held for a retry' }], { write: false });
        return;
      default: {
        const unhandled: never = outcome;
        return unhandled;
      }
    }
  };

  /** §27.9.1 N9b.7 — the step's completion as resolved at the gate; an unresolvable def cannot be cleared of the check. */
  const needsFrozenCheck = (repoDir: string, run: AutoRun, step: string): boolean => {
    const loop = run.bound.get(step)?.loop;
    if (loop === undefined) return false;
    let res: DefResolution | null;
    try {
      res = deps.resolveDef(repoDir, loop);
    } catch {
      res = null;
    }
    return res === null || isFrozenCheckCompletion(res.completion) || res.frozenCheck === true;
  };

  /** An unreadable or absent run-state has not left the gate: the check's result still decides it. */
  const runStateLeft = (repoDir: string, d: Deciding): boolean => {
    try {
      const state = readAppLoopState(repoDir);
      return state !== null && (state.step !== d.step || state.turnKey !== d.turnKey);
    } catch {
      return false;
    }
  };

  const standDown = (repoDir: string, run: AutoRun): void => {
    clearDeciding(run);
    push(repoDir);
  };

  const decide = (repoDir: string, run: AutoRun, d: Deciding, cause: GateCause): void => {
    const reasons = evaluate(repoDir, run, d.step, cause);
    if (d.humanAttempted) {
      standDown(repoDir, run);
      return;
    }
    if (!needsFrozenCheck(repoDir, run, d.step)) {
      conclude(repoDir, run, d, reasons);
      return;
    }
    d.checking = reasons;
    void approveTimeFrozenCheck(repoDir, d.check.signal).then((result) => {
      d.checking = null;
      if (d.ended || runs.get(repoDir) !== run || run.deciding !== d) return;
      if (d.humanAttempted || d.check.signal.aborted || runStateLeft(repoDir, d)) {
        standDown(repoDir, run);
        return;
      }
      conclude(repoDir, run, d, [...reasons, ...frozenCheckReasons(repoDir, d.step, result)]);
    });
  };

  /** §27.9.1 N9b.6(e), N9b.7(d) */
  const frozenCheckReasons = (repoDir: string, step: string, result: ApproveTimeFrozenCheck): Reason[] => {
    if (!result.ok) return [{ reason: 'frozen-check-unavailable', detail: result.detail }];
    try {
      recordChangedTests(repoDir, step, result.paths);
    } catch (e) {
      return [{ reason: 'frozen-check-unavailable', detail: `changed-tests.yaml could not be written: ${errMsg(e)}` }];
    }
    try {
      recordRedTestChanges(repoDir, { branch: result.branch, step, slice: deps.currentSlice(repoDir), paths: result.paths });
    } catch (e) {
      return [{ reason: 'frozen-check-unavailable', detail: `red-test-changes.yaml could not be written: ${errMsg(e)}` }];
    }
    return [];
  };

  const conclude = (repoDir: string, run: AutoRun, d: Deciding, reasons: Reason[]): void => {
    if (reasons.length > 0) {
      halt(repoDir, run, d, reasons);
      return;
    }
    const bound = run.bound.get(d.step);
    if (approve === null || bound === undefined) {
      halt(repoDir, run, d, [{ reason: 'approve-not-persisted', detail: 'engine approve not wired' }]);
      return;
    }
    const decider: ApproveDecider = {
      kind: 'engine',
      boundLoop: bound.loop,
      humanAttempted: () => d.humanAttempted,
      claimAccept: () => claim(repoDir, run, d),
    };
    d.approveStarted = true;
    let pending: Promise<GateApproveOutcome>;
    try {
      pending = approve(repoDir, d.step, d.turnKey, decider);
    } catch (e) {
      settle(repoDir, run, d, { kind: 'threw', reason: errMsg(e) });
      return;
    }
    pending.then(
      (outcome) => settle(repoDir, run, d, outcome),
      (e: unknown) => settle(repoDir, run, d, { kind: 'threw', reason: errMsg(e) }),
    );
  };

  /** §27.9.1 N9b.5(e) — the one atomic abandon-or-proceed decision, with the policy re-checked at the operation. */
  const claim = (repoDir: string, run: AutoRun, d: Deciding): ApproveClaim => {
    if (d.ended || runs.get(repoDir) !== run) return { ok: false, runEnded: true };
    let inProgress: boolean;
    try {
      inProgress = deps.runInProgressAt(repoDir, d.step);
    } catch {
      return { ok: false, reasons: ['engine-input-missing'] };
    }
    if (!inProgress) return { ok: false, runEnded: true };
    if (d.abandoned) return { ok: false, abandoned: true };
    const arm = probeArmedInterrupt(repoDir).kind;
    if (arm === 'set') return { ok: false, reasons: ['interrupt-armed'] };
    if (arm === 'unreadable') return { ok: false, reasons: ['engine-input-missing'] };
    d.claimed = true;
    return { ok: true };
  };

  const buildRun = (start: StartRun, identity: RunIdentity): AutoRun => {
    const auto: AutoRun = {
      identity,
      stateUnsaved: false,
      humanDecisions: 0,
      atRunEnd: false,
      steps: start.definition.steps,
      bound: new Map(),
      loopRun: null,
      failedEffect: null,
      relaunchHalt: null,
      gateSeq: 0,
      pendingGate: null,
      deciding: null,
      hung: null,
      haltShown: null,
      asked: null,
    };
    for (const step of start.definition.steps) {
      if (step.kind !== 'loop' || step.loop === undefined) continue;
      if (step.gateAuthority !== 'auto') {
        auto.bound.set(step.id, { authority: 'human', loop: step.loop });
        continue;
      }
      auto.bound.set(step.id, { authority: 'auto', loop: step.loop });
    }
    return auto;
  };

  /** §27.9.1 N9b.8 — a relaunched run keeps its authority; a gate it had already reached halts with (j). */
  const rebuild = (repoKey: string): AutoRun | undefined => {
    if (replaced.has(repoKey)) return undefined;
    let identity: RunIdentity | null;
    let start: StartRun | null;
    try {
      identity = inProgressRunIdentity(repoKey);
      start = identity === null ? null : deps.currentRun(repoKey);
    } catch {
      return undefined;
    }
    if (identity === null || start === null) return undefined;
    const run = buildRun(start, identity);
    const persisted = isAuto(run) ? readGateRunState(repoKey) : null;
    if (persisted?.kind === 'unreadable') {
      run.failedEffect = { state: 'unknown', detail: 'the run\'s gate state could not be read', reported: false };
    } else if (persisted?.kind === 'absent') {
      run.failedEffect = { state: 'unknown', detail: 'the run\'s gate state is missing', reported: false };
    } else if (persisted?.kind === 'ok' && sameRun(persisted.state.run, identity)) {
      const lr = persisted.state.loopRun;
      run.loopRun = lr === null ? null : { ...lr, recorded: new Set(lr.recorded) };
      run.failedEffect = persisted.state.failedEffect;
      run.relaunchHalt = persisted.state.relaunchHalt;
    }
    runs.set(repoKey, run);
    resumeGate(repoKey, run);
    return run;
  };

  const resumeGate = (repoDir: string, run: AutoRun): void => {
    let state: ReturnType<typeof readAppLoopState>;
    try {
      state = readAppLoopState(repoDir);
    } catch {
      return;
    }
    if (state === null || state.status !== 'complete' || state.verdict === undefined || !honouredAuto(run, state.step)) return;
    let leftGate: boolean;
    try {
      leftGate = !deps.runInProgressAt(repoDir, state.step) || isPolishActiveForStep(repoDir, state.step);
    } catch {
      leftGate = false;
    }
    if (leftGate) return;
    nextGate(run);
    const key = { step: state.step, turnKey: state.turnKey, gateSeq: run.gateSeq };
    const gate: RelaunchHalt = { step: state.step, turnKey: state.turnKey, round: state.round ?? null };
    const prior = run.relaunchHalt;
    const written = prior !== null && prior.step === gate.step && prior.turnKey === gate.turnKey && prior.round === gate.round;
    if (!written) {
      run.relaunchHalt = gate;
      persist(repoDir, run);
    }
    const verdictHalt = verdictReason(state.verdict);
    const reasons: Reason[] = [{ reason: 'relaunched' }, ...(verdictHalt !== null ? [{ reason: verdictHalt }] : [])];
    for (const r of evaluate(repoDir, run, state.step, 'verdict')) if (!reasons.some((x) => x.reason === r.reason)) reasons.push(r);
    halt(repoDir, run, key, reasons, { write: !written, ask: false });
  };

  const runFor = (repoKey: string): AutoRun | undefined => runs.get(repoKey) ?? rebuild(repoKey);

  const autoGateViewFor: AutoGateViewFor = (repoKey, step, turnKey) => {
    const run = runFor(repoKey);
    if (run === undefined || !isAuto(run)) return undefined;
    const d = run.deciding;
    if (d !== null && runStateLeft(repoKey, d)) d.check.abort();
    const shown = sameGate(run.haltShown, step, turnKey, run.gateSeq) ? run.haltShown!.reasons : [];
    const hung = sameGate(run.hung, step, turnKey, run.gateSeq);
    const view: FlowAutoGateView = {
      deciding: !hung && sameGate(run.deciding, step, turnKey, run.gateSeq),
      hung,
      haltReasons: shown,
      ...(run.failedEffect !== null ? { failedEffect: { state: run.failedEffect.state, detail: run.failedEffect.detail } } : {}),
    };
    return view;
  };

  const nextGate = (run: AutoRun): void => {
    run.gateSeq += 1;
    run.haltShown = null;
    run.hung = null;
  };

  return {
    bindAtStart(repoKey, run, startedAt) {
      replaced.set(repoKey, runs.get(repoKey));
      runs.set(repoKey, buildRun(run, { flow: run.definition.name, startedAt }));
    },
    discardStart(repoKey) {
      if (!replaced.has(repoKey)) return;
      const prior = replaced.get(repoKey);
      replaced.delete(repoKey);
      if (prior === undefined) runs.delete(repoKey);
      else {
        runs.set(repoKey, prior);
        persist(repoKey, prior);
      }
    },
    commitStart(repoKey) {
      replaced.delete(repoKey);
      const run = runs.get(repoKey);
      if (run !== undefined) persist(repoKey, run);
    },
    endRun(repoKey) {
      withdrawQuestion();
      const run = runs.get(repoKey);
      if (run === undefined) return;
      if (run.deciding !== null) run.deciding.ended = true;
      clearDeciding(run);
      runs.delete(repoKey);
    },
    beginLoopRun(repoKey, step) {
      const run = runFor(repoKey);
      if (run === undefined) return;
      withdrawQuestion();
      run.loopRun = { step, endedInError: false, acceptedFailure: false, needsAHuman: false, recorded: new Set() };
      run.atRunEnd = false;
      run.relaunchHalt = null;
      nextGate(run);
      persist(repoKey, run);
    },
    gateReaching(repoDir, step, turnKey, verdict, cause) {
      const run = runFor(repoDir);
      if (run === undefined) return;
      nextGate(run);
      clearDeciding(run);
      if (run.relaunchHalt !== null) {
        run.relaunchHalt = null;
        persist(repoDir, run);
      }
      run.pendingGate = { step, turnKey, gateSeq: run.gateSeq, verdict, cause };
      if (!honouredAuto(run, step) || verdict !== 'clean' || cause !== 'verdict') return;
      const key = { step, turnKey, gateSeq: run.gateSeq };
      const d: Deciding = { ...key, humanAttempted: false, approveStarted: false, claimed: false, abandoned: false, ended: false, checking: null, check: new AbortController(), timer: { id: -1 } };
      d.timer = deps.setTimer(() => onBound(repoDir, run, d), deps.decisionBoundMs);
      run.deciding = d;
    },
    gateReached(repoDir, step, turnKey) {
      const run = runFor(repoDir);
      const pg = run?.pendingGate ?? null;
      if (run === undefined || pg === null || !sameGate(pg, step, turnKey, run.gateSeq)) return;
      run.pendingGate = null;
      if (!honouredAuto(run, step)) {
        askWhy(run, pg, { kind: 'human-gate', step });
        return;
      }
      const verdictHalt = pg.cause === 'interrupt' ? 'interrupt-armed' : pg.cause === 'arm-unreadable' ? 'engine-input-missing' : verdictReason(pg.verdict);
      if (verdictHalt !== null) {
        const held = evaluate(repoDir, run, step, pg.cause);
        const lead = held.find((r) => r.reason === verdictHalt) ?? { reason: verdictHalt };
        halt(repoDir, run, pg, [lead, ...held.filter((r) => r !== lead)]);
        return;
      }
      const d = run.deciding;
      if (d === null || !sameGate(d, step, turnKey, pg.gateSeq)) return;
      decide(repoDir, run, d, pg.cause);
    },
    gateNotReached(repoDir, step, turnKey) {
      const run = runs.get(repoDir);
      if (run === undefined) return;
      if (run.pendingGate?.step === step && run.pendingGate.turnKey === turnKey) run.pendingGate = null;
      if (run.deciding?.step === step && run.deciding.turnKey === turnKey) clearDeciding(run);
      push(repoDir);
    },
    loopRunEvent(repoDir, step, turnKey, event) {
      const run = runFor(repoDir);
      const lr = run?.loopRun ?? null;
      if (run === undefined || lr === null || lr.step !== step) return;
      const haltOnFailedLoopRun = (resume?: StalledTurn): void => {
        persist(repoDir, run);
        if (!honouredAuto(run, step)) return;
        halt(repoDir, run, { step, turnKey, gateSeq: run.gateSeq }, [{ reason: 'loop-error' }], { write: true, ...(resume === undefined ? {} : { resume }) });
        lr.recorded.add('loop-error');
        persist(repoDir, run);
      };
      if (event === 'error') {
        lr.endedInError = true;
        haltOnFailedLoopRun();
        return;
      }
      if (typeof event === 'object' && 'resumableStall' in event) {
        lr.endedInError = true;
        haltOnFailedLoopRun({ turnKey, doneRelPath: event.resumableStall.doneRelPath });
        return;
      }
      if (event === 'retried') {
        withdrawQuestion();
        lr.endedInError = false;
        if (!lr.acceptedFailure) lr.recorded.delete('loop-error');
        nextGate(run);
        persist(repoDir, run);
        push(repoDir);
        return;
      }
      if (event === 'accepted') {
        lr.acceptedFailure = true;
        haltOnFailedLoopRun();
        return;
      }
      lr.needsAHuman = event.roundReport === null || reportNeedsAHuman(event.roundReport) !== false;
      persist(repoDir, run);
    },
    interruptArmed(repoDir, step) {
      const run = runFor(repoDir);
      if (run !== undefined && isAuto(run)) return probeArmedInterrupt(repoDir).kind;
      return readArmedInterrupt(repoDir)?.step === step ? 'set' : 'absent';
    },
    consumeInterrupt(repoDir) {
      consumeOrReport(repoDir);
    },
    humanDecision(repoKey, step, turnKey) {
      const run = runFor(repoKey);
      if (run === undefined) return () => {};
      withdrawQuestion();
      const d = run.deciding;
      if (d !== null && d.step === step && (turnKey === null || d.turnKey === turnKey)) {
        d.humanAttempted = true;
        d.check.abort();
      }
      const atGate = run.loopRun?.step === step || run.haltShown?.step === step;
      const clearFailed = clearFailedAt(run, step);
      run.humanDecisions += 1;
      return (landed) => {
        run.humanDecisions -= 1;
        if (runs.get(repoKey) !== run) return;
        if (landed && clearFailed) consumeOrReport(repoKey);
        const shown = run.haltShown;
        if (landed && shown !== null && shown.step === step && (turnKey === null || shown.turnKey === turnKey)) {
          run.haltShown = null;
          push(repoKey);
        }
        if (landed && atGate && run.failedEffect !== null) {
          run.failedEffect = null;
          persist(repoKey, run);
          push(repoKey);
        }
        if (run.atRunEnd) reportRunEnd(repoKey, run);
      };
    },
    flowTransitioned(repoKey, after) {
      const run = runFor(repoKey);
      if (run === undefined) return;
      run.atRunEnd = reachedRunEnd(run, after);
      if (run.atRunEnd) reportRunEnd(repoKey, run);
    },
    attachApprove(fn) {
      approve = fn;
    },
    isAutoRun(repoKey) {
      const run = runFor(repoKey);
      return run !== undefined && isAuto(run);
    },
    autoGateViewFor,
  };
}
