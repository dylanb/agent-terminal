// §27.9.1 — the engine-held gate controller: who decides an `auto` step's gate, from engine-held inputs only.

import { execFileSync } from 'node:child_process';
import type { ConsolidatorVerdict } from '../shared/consolidatorOutput';
import type { FlowAutoGateView } from '../shared/ipc';
import { autoHaltAuditCmd } from '../shared/audit';
import type { AutoHaltReason } from '../shared/gateAuthority';
import { isGitObjectId } from '../shared/appBootstrap';
import { displaySafeEcho, MAX_ECHOED_REASON_LENGTH } from '../shared/controlChars';
import { reportNeedsAHuman } from '../shared/roundReport';
import type { FlowDefinition } from './flow';
import type { ApproveClaim, ApproveDecider, GateApproveOutcome } from './appGateDecision';
import type { AutoGateViewFor } from './loopViewV2';
import type { DispositionRead } from './resolveRunDefinition';
import { loopDefIdentity, type LoopDefV2Result } from './loopDefV2';
import { clearInterrupt, readArmedInterrupt } from './appLoopState';
import { commandEnvironment } from './appCommand';
import { coreExecHardeningArgs, freshDisabledHooksDir } from './gitHardening';
import { errMsg } from './errno';
import { NO_LAZY_FETCH_ENV, OBJECT_SOURCE_HARDENING } from './frozenTests';

// §27.9.1 N9b.5(e)
export const AUTO_GATE_DECISION_DEFAULT_MS = 300_000;
// §27.9.1 N9b.7(a)
export const START_CAPTURE_TIMEOUT_MS = 5_000;

export type DefTier = 'repo' | 'operator' | 'app-bundled';
export interface DefIdentity {
  name: string;
  digest: string;
}
export interface DefResolution {
  tier: DefTier;
  identity: DefIdentity | null;
  completion?: 'red' | 'green' | 'refactor';
}

export interface StartRun {
  definition: FlowDefinition;
  flowSourceTrust: 'operator' | 'repo';
  binding?: DispositionRead;
}

export type GateCause = 'verdict' | 'interrupt';
export type LoopRunEvent = 'error' | 'retried' | 'accepted' | { roundReport: string | null };
export type EngineApprove = (repoDir: string, step: string, turnKey: string, decider: ApproveDecider) => Promise<GateApproveOutcome>;
export interface AutoGateTimer {
  readonly id: number;
}

export interface AutoGateDeps {
  audit: (repoDir: string, cmd: string, exit: number | null) => void;
  resolveDef: (repoDir: string, loop: string) => DefResolution | null;
  /** The run's flow source re-resolved from the binding its Start held (§27.9.1 N9b.2(c)); null when it no longer loads. */
  currentRun: (repoDir: string, heldBinding: DispositionRead | undefined) => StartRun | null;
  runInProgressAt: (repoDir: string, step: string) => boolean;
  onViewChanged: (repoKey: string) => void;
  setTimer: (cb: () => void, ms: number) => AutoGateTimer;
  clearTimer: (handle: AutoGateTimer) => void;
}

export interface AutoGate {
  bindAtStart(repoKey: string, run: StartRun, startedAt: number, captureTrustedGlobsCommit: (repoDir: string) => string | null): void;
  discardStart(repoKey: string): void;
  commitStart(repoKey: string): void;
  endRun(repoKey: string): void;
  clearAuthority(repoKey: string): void;
  beginLoopRun(repoKey: string, step: string): void;
  observeDefResolution(repoKey: string, name: string, result: DefResolution | null): void;
  gateReaching(repoDir: string, step: string, turnKey: string, verdict: ConsolidatorVerdict, cause: GateCause): void;
  gateReached(repoDir: string, step: string, turnKey: string): void;
  gateNotReached(repoDir: string, step: string, turnKey: string): void;
  loopRunEvent(repoDir: string, step: string, turnKey: string, event: LoopRunEvent): void;
  interruptArmed(repoDir: string, step: string): boolean;
  consumeInterrupt(repoDir: string): void;
  armInterrupt(repoKey: string, step: string): void;
  humanAttempt(repoKey: string): void;
  attachApprove(approve: EngineApprove): void;
  isAutoRun(repoKey: string): boolean;
  autoGateViewFor: AutoGateViewFor;
}

/** The `DefResolution` the controller compares, read off a def resolution (§27.9.1 N9b.2(b)). */
export function defResolutionOf(r: LoopDefV2Result): DefResolution | null {
  if (!r.ok) return null;
  return { tier: r.tier ?? 'repo', identity: loopDefIdentity(r), ...(r.def.work.completion ? { completion: r.def.work.completion } : {}) };
}

// Until S2–S4 land their letter-keyed rows, every other reason shows as the one generic row.
const SHOWN_REASONS: ReadonlySet<AutoHaltReason> = new Set(['stop-for-a-human', 'c', 'e']);

type Reason = { reason: AutoHaltReason; detail?: string };

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
  timer: AutoGateTimer;
}

interface LoopRun {
  step: string;
  repoTierSeen: boolean;
  identityMismatch: boolean;
  identityUnread: boolean;
  endedInError: boolean;
  acceptedFailure: boolean;
  needsAHuman: boolean;
  recorded: Set<AutoHaltReason>;
}

interface AutoRun {
  steps: FlowDefinition['steps'];
  cleared: boolean;
  bound: Map<string, { authority: 'auto' | 'human'; loop: string }>;
  untrusted: Set<string>;
  defIdentity: Map<string, DefIdentity | null>;
  frozenCheck: Set<string>;
  heldBinding: DispositionRead | undefined;
  trustedGlobsCommit: string | null;
  loopRun: LoopRun | null;
  arm: string | null;
  failedEffect: { state: 'set' | 'unknown'; detail: string } | null;
  gateSeq: number;
  pendingGate: (GateKey & { verdict: ConsolidatorVerdict; cause: GateCause }) | null;
  deciding: Deciding | null;
  hung: GateKey | null;
  haltShown: (GateKey & { reasons: Reason[] }) | null;
}

const sameGate = (a: GateKey | null, step: string, turnKey: string, gateSeq: number): boolean =>
  a !== null && a.step === step && a.turnKey === turnKey && a.gateSeq === gateSeq;

const sameIdentity = (a: DefIdentity | null, b: DefIdentity | null): boolean => a !== null && b !== null && a.name === b.name && a.digest === b.digest;

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

  const isAuto = (run: AutoRun): boolean => [...run.bound.values()].some((b) => b.authority === 'auto');
  const honouredAuto = (run: AutoRun, step: string): boolean => !run.cleared && run.bound.get(step)?.authority === 'auto';
  const fileArmed = (repoDir: string): boolean => {
    try {
      return readArmedInterrupt(repoDir) !== null;
    } catch {
      return true;
    }
  };

  const clearDeciding = (run: AutoRun): void => {
    if (run.deciding === null) return;
    deps.clearTimer(run.deciding.timer);
    run.deciding = null;
  };

  const consume = (run: AutoRun, repoDir: string): void => {
    run.arm = null;
    bestEffort(() => clearInterrupt(repoDir));
  };

  /** One engine-decided entry naming every reason (§27.9.1 N9b.9), then the gate is the human's. */
  const halt = (repoDir: string, run: AutoRun, key: GateKey, reasons: Reason[], opts: { write: boolean } = { write: true }): void => {
    if (reasons.some((r) => r.reason === 'c')) consume(run, repoDir);
    const lr = run.loopRun;
    const recordedAlready = lr !== null && lr.step === key.step && reasons.every((r) => lr.recorded.has(r.reason));
    if (opts.write && !recordedAlready) bestEffort(() => deps.audit(repoDir, autoHaltAuditCmd(reasons), 0));
    run.haltShown = { step: key.step, turnKey: key.turnKey, gateSeq: key.gateSeq, reasons };
    if (sameGate(run.deciding, key.step, key.turnKey, key.gateSeq)) clearDeciding(run);
    push(repoDir);
  };

  /** The approve-site trust checks (§27.9.1 N9b.2(c)): only ever lowered. */
  const trustReasons = (repoDir: string, run: AutoRun, step: string): Reason[] => {
    const lr = run.loopRun;
    const lowered =
      !honouredAuto(run, step) ||
      run.untrusted.has(step) ||
      (lr !== null && lr.step === step && (lr.repoTierSeen || lr.identityMismatch)) ||
      sourceLowered(repoDir, run, step);
    return lowered ? [{ reason: 'g' }] : [];
  };

  const sourceLowered = (repoDir: string, run: AutoRun, step: string): boolean => {
    const current = deps.currentRun(repoDir, run.heldBinding);
    if (current === null || current.flowSourceTrust !== 'operator') return true;
    return current.definition.steps.find((s) => s.id === step)?.gateAuthority !== 'auto';
  };

  /** §27.9.1 N9b.6 (a)–(j), evaluated from engine-held values; `frozen` adds the approve-only frozen check. */
  const evaluate = (repoDir: string, run: AutoRun, step: string, cause: GateCause, frozen: boolean): Reason[] => {
    const reasons: Reason[] = [];
    const lr = run.loopRun !== null && run.loopRun.step === step ? run.loopRun : null;
    if (lr === null || lr.needsAHuman) reasons.push({ reason: 'a' });
    if (lr !== null && (lr.endedInError || lr.acceptedFailure)) reasons.push({ reason: 'b' });
    if (cause === 'interrupt' || run.arm !== null || fileArmed(repoDir)) reasons.push({ reason: 'c' });
    // S4 replaces this fail-closed stub with the approve-time frozen check.
    if (frozen && run.frozenCheck.has(step)) reasons.push({ reason: 'e', detail: 'the approve-time frozen check is not available' });
    reasons.push(...trustReasons(repoDir, run, step));
    if (lr === null || lr.identityUnread || run.trustedGlobsCommit === null || (run.defIdentity.get(step) ?? null) === null) reasons.push({ reason: 'h' });
    if (run.failedEffect !== null) reasons.push({ reason: 'i' });
    return reasons;
  };

  const verdictReason = (verdict: ConsolidatorVerdict): AutoHaltReason | null => {
    switch (verdict) {
      case 'clean':
        return null;
      case 'stop for a human':
        return 'stop-for-a-human';
      case 'another round':
        return 'c';
    }
  };

  const onBound = (repoDir: string, run: AutoRun, d: Deciding): void => {
    if (runs.get(repoDir) !== run || run.deciding !== d) return;
    if (d.claimed) {
      run.hung = { step: d.step, turnKey: d.turnKey, gateSeq: d.gateSeq };
      run.failedEffect = { state: 'set', detail: 'the engine approve did not settle within its bound' };
      push(repoDir);
      return;
    }
    d.abandoned = true;
    halt(repoDir, run, d, [d.approveStarted ? { reason: 'l', detail: 'the engine approve did not settle within its bound' } : { reason: 'h', detail: 'the gate could not be evaluated' }]);
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
        if (outcome.effectFailures.length > 0) run.failedEffect = { state: 'set', detail: detail(outcome.effectFailures.join('; ')) };
        clearDeciding(run);
        push(repoDir);
        return;
      case 'preview-raised':
        halt(repoDir, run, d, [{ reason: 'k' }], { write: false });
        return;
      case 'blocked':
        halt(repoDir, run, d, [{ reason: 'k' }]);
        return;
      case 'refused':
        halt(repoDir, run, d, [{ reason: 'l', detail: detail(outcome.reason) }]);
        return;
      case 'accept-failed':
        halt(repoDir, run, d, [{ reason: 'l', detail: detail(outcome.reason) }], { write: false });
        return;
      case 'abandoned':
        halt(repoDir, run, d, [{ reason: 'l', detail: 'the engine approve did not settle within its bound' }]);
        return;
      case 'refused-late':
        halt(repoDir, run, d, [...outcome.reasons.map((reason) => ({ reason })), { reason: 'l', detail: 'the gate changed while the engine decided' }]);
        return;
      case 'run-ended':
      case 'stood-down':
        clearDeciding(run);
        push(repoDir);
        return;
      case 'threw':
        run.failedEffect = { state: 'set', detail: detail(outcome.reason) };
        halt(repoDir, run, d, [{ reason: 'l', detail: detail(outcome.reason) }]);
        return;
    }
  };

  const decide = (repoDir: string, run: AutoRun, d: Deciding, cause: GateCause): void => {
    const reasons = evaluate(repoDir, run, d.step, cause, true);
    if (d.humanAttempted) {
      clearDeciding(run);
      push(repoDir);
      return;
    }
    if (reasons.length > 0) {
      halt(repoDir, run, d, reasons);
      return;
    }
    const bound = run.bound.get(d.step);
    if (approve === null || bound === undefined) {
      halt(repoDir, run, d, [{ reason: 'l', detail: 'engine approve not wired' }]);
      return;
    }
    const decider: ApproveDecider = {
      kind: 'engine',
      boundLoop: bound.loop,
      humanAttempted: () => d.humanAttempted,
      claimAccept: () => claim(repoDir, run, d),
      checkDef: (r) => checkDef(run, d.step, r),
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
      return { ok: false, reasons: ['h'] };
    }
    if (!inProgress) return { ok: false, runEnded: true };
    if (d.abandoned) return { ok: false, abandoned: true };
    const late: AutoHaltReason[] = [];
    if (run.arm !== null || fileArmed(repoDir)) late.push('c');
    let lowered: boolean;
    try {
      lowered = trustReasons(repoDir, run, d.step).length > 0;
    } catch {
      lowered = true;
    }
    if (lowered) late.push('g');
    if (late.length > 0) return { ok: false, reasons: late };
    d.claimed = true;
    return { ok: true };
  };

  /** §27.9.1 N9b.5(c) — the def the approve resolved must be the one Start held for this step. */
  const checkDef = (run: AutoRun, step: string, r: LoopDefV2Result): string | null => {
    if (!r.ok) return r.reason;
    if (r.tier === undefined || r.tier === 'repo') return 'the def resolved from a repo tier';
    const held = run.defIdentity.get(step) ?? null;
    const now = loopDefIdentity(r);
    if (held === null || now === null) return 'the def identity held at Start is missing';
    return sameIdentity(held, now) ? null : 'the def changed since Start';
  };

  const autoGateViewFor: AutoGateViewFor = (repoKey, step, turnKey) => {
    const run = runs.get(repoKey);
    if (run === undefined || !isAuto(run)) return undefined;
    const shown = sameGate(run.haltShown, step, turnKey, run.gateSeq) ? run.haltShown!.reasons : [];
    const view: FlowAutoGateView = {
      deciding: sameGate(run.deciding, step, turnKey, run.gateSeq),
      hung: sameGate(run.hung, step, turnKey, run.gateSeq),
      haltGeneric: shown.some((r) => !SHOWN_REASONS.has(r.reason)),
      haltReasons: shown.filter((r) => SHOWN_REASONS.has(r.reason)),
      ...(run.failedEffect !== null ? { failedEffect: { ...run.failedEffect } } : {}),
    };
    return view;
  };

  const nextGate = (run: AutoRun): void => {
    run.gateSeq += 1;
    run.haltShown = null;
    run.hung = null;
  };

  return {
    bindAtStart(repoKey, run, _startedAt, captureTrustedGlobsCommit) {
      replaced.set(repoKey, runs.get(repoKey));
      const auto: AutoRun = {
        steps: run.definition.steps,
        cleared: false,
        bound: new Map(),
        untrusted: new Set(),
        defIdentity: new Map(),
        frozenCheck: new Set(),
        heldBinding: run.binding,
        trustedGlobsCommit: null,
        loopRun: null,
        arm: null,
        failedEffect: null,
        gateSeq: 0,
        pendingGate: null,
        deciding: null,
        hung: null,
        haltShown: null,
      };
      for (const step of run.definition.steps) {
        if (step.kind !== 'loop' || step.loop === undefined) continue;
        if (step.gateAuthority !== 'auto') {
          auto.bound.set(step.id, { authority: 'human', loop: step.loop });
          continue;
        }
        let res: DefResolution | null = null;
        if (run.flowSourceTrust === 'operator') {
          try {
            res = deps.resolveDef(repoKey, step.loop);
          } catch {
            res = null;
          }
        }
        if (run.flowSourceTrust !== 'operator' || res?.tier === 'repo') {
          auto.bound.set(step.id, { authority: 'human', loop: step.loop });
          auto.untrusted.add(step.id);
          continue;
        }
        auto.bound.set(step.id, { authority: 'auto', loop: step.loop });
        auto.defIdentity.set(step.id, res?.identity ?? null);
        if (isFrozenCheckCompletion(res?.completion)) auto.frozenCheck.add(step.id);
      }
      if (isAuto(auto)) {
        try {
          auto.trustedGlobsCommit = captureTrustedGlobsCommit(repoKey);
        } catch {
          auto.trustedGlobsCommit = null;
        }
      }
      runs.set(repoKey, auto);
    },
    discardStart(repoKey) {
      if (!replaced.has(repoKey)) return;
      const prior = replaced.get(repoKey);
      replaced.delete(repoKey);
      if (prior === undefined) runs.delete(repoKey);
      else runs.set(repoKey, prior);
    },
    commitStart(repoKey) {
      replaced.delete(repoKey);
    },
    endRun(repoKey) {
      const run = runs.get(repoKey);
      if (run === undefined) return;
      if (run.deciding !== null) run.deciding.ended = true;
      clearDeciding(run);
      runs.delete(repoKey);
    },
    clearAuthority(repoKey) {
      const run = runs.get(repoKey);
      if (run !== undefined) run.cleared = true;
    },
    beginLoopRun(repoKey, step) {
      const run = runs.get(repoKey);
      if (run === undefined) return;
      run.loopRun = { step, repoTierSeen: false, identityMismatch: false, identityUnread: false, endedInError: false, acceptedFailure: false, needsAHuman: false, recorded: new Set() };
      nextGate(run);
    },
    observeDefResolution(repoKey, name, result) {
      const run = runs.get(repoKey);
      const lr = run?.loopRun ?? null;
      if (run === undefined || lr === null) return;
      const bound = run.bound.get(lr.step);
      if (bound === undefined) return;
      if (result === null || name !== bound.loop) lr.identityMismatch = true;
      else if (result.tier === 'repo') lr.repoTierSeen = true;
      else if (bound.authority === 'auto') {
        const held = run.defIdentity.get(lr.step) ?? null;
        if (held === null) return;
        if (result.identity === null) lr.identityUnread = true;
        else if (!sameIdentity(held, result.identity)) lr.identityMismatch = true;
      }
    },
    gateReaching(repoDir, step, turnKey, verdict, cause) {
      const run = runs.get(repoDir);
      if (run === undefined) return;
      nextGate(run);
      clearDeciding(run);
      run.pendingGate = { step, turnKey, gateSeq: run.gateSeq, verdict, cause };
      if (!honouredAuto(run, step) || verdict !== 'clean' || cause !== 'verdict') return;
      const key = { step, turnKey, gateSeq: run.gateSeq };
      const d: Deciding = { ...key, humanAttempted: false, approveStarted: false, claimed: false, abandoned: false, ended: false, timer: { id: -1 } };
      d.timer = deps.setTimer(() => onBound(repoDir, run, d), AUTO_GATE_DECISION_DEFAULT_MS);
      run.deciding = d;
    },
    gateReached(repoDir, step, turnKey) {
      const run = runs.get(repoDir);
      const pg = run?.pendingGate ?? null;
      if (run === undefined || pg === null || !sameGate(pg, step, turnKey, run.gateSeq)) return;
      run.pendingGate = null;
      if (!honouredAuto(run, step)) return;
      const verdictHalt = pg.cause === 'interrupt' ? 'c' : verdictReason(pg.verdict);
      if (verdictHalt !== null) {
        const others = evaluate(repoDir, run, step, pg.cause, false).filter((r) => r.reason !== verdictHalt);
        halt(repoDir, run, pg, [{ reason: verdictHalt }, ...others]);
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
      const run = runs.get(repoDir);
      const lr = run?.loopRun ?? null;
      if (run === undefined || lr === null || lr.step !== step) return;
      if (event === 'error') {
        lr.endedInError = true;
        return;
      }
      if (event === 'retried') {
        lr.endedInError = false;
        nextGate(run);
        return;
      }
      if (event === 'accepted') {
        lr.acceptedFailure = true;
        if (!honouredAuto(run, step)) return;
        halt(repoDir, run, { step, turnKey, gateSeq: run.gateSeq }, [{ reason: 'b' }]);
        lr.recorded.add('b');
        return;
      }
      lr.needsAHuman = event.roundReport === null || reportNeedsAHuman(event.roundReport) !== false;
    },
    interruptArmed(repoDir, step) {
      const run = runs.get(repoDir);
      if (run !== undefined && isAuto(run)) return run.arm !== null || fileArmed(repoDir);
      return readArmedInterrupt(repoDir)?.step === step;
    },
    consumeInterrupt(repoDir) {
      const run = runs.get(repoDir);
      if (run !== undefined) run.arm = null;
      clearInterrupt(repoDir);
    },
    armInterrupt(repoKey, step) {
      const run = runs.get(repoKey);
      if (run !== undefined) run.arm = step;
    },
    humanAttempt(repoKey) {
      const d = runs.get(repoKey)?.deciding;
      if (d) d.humanAttempted = true;
    },
    attachApprove(fn) {
      approve = fn;
    },
    isAutoRun(repoKey) {
      const run = runs.get(repoKey);
      return run !== undefined && isAuto(run);
    },
    autoGateViewFor,
  };
}

/** §27.9.1 N9b.7(a) — the commit the run's test globs are trusted at, captured at Start; null on any failure. */
export function captureTrustedGlobsCommit(repoDir: string, timeoutMs: number): string | null {
  try {
    const out = execFileSync(
      'git',
      [...OBJECT_SOURCE_HARDENING, ...coreExecHardeningArgs(freshDisabledHooksDir()), 'rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'],
      { cwd: repoDir, encoding: 'utf8', env: commandEnvironment(NO_LAZY_FETCH_ENV), timeout: timeoutMs, stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    return isGitObjectId(out) ? out : null;
  } catch {
    return null;
  }
}
