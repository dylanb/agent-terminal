import { randomUUID } from 'node:crypto';
import type { AppLoopEnterResult, AppLoopEntry, PickupBranch } from './appLoopEngine';
import type { AppLoopBootstrap, PickupRecord } from './appLoopState';
import type { AppGateRefs } from './appGateDecision';
import {
  AmbiguousBootstrapOperationError,
  OwnedBootstrapBranchError,
  UnresolvedRemoteBootstrapBranchError,
  type AppBootstrapConflicts,
  type AppBootstrapGit,
  type AppBootstrapGitHub,
} from './bootstrapPorts';
import type { PickupContractV2 } from './loopDefV2';
import { errMsg } from './errno';
import type { AppBootstrapAuditKind } from '../shared/audit';
import { BUSY_NOTICE } from './flowEntryActions';
import {
  hasAppBootstrapConflict,
  sameAppBootstrapConflictTarget,
  type AppBootstrapConflictTarget,
} from '../shared/appBootstrap';
import type { FlowRefs } from '../shared/ipc';

export interface AppLoopBootstrapDeps {
  git: AppBootstrapGit;
  github: AppBootstrapGitHub;
  conflicts: AppBootstrapConflicts;
  prepareBootstrap(identity: Omit<AppLoopBootstrap, 'pr'>): void;
  writeBootstrap(identity: AppLoopBootstrap): void;
  clearBootstrap(): void;
}

export interface AppLoopBootstrapRequest {
  issue: number;
  spec: AppLoopBootstrapSpec;
  confirmedWipe?: AppBootstrapConflictTarget;
}

// Def tiers carry no trust distinction (v2.129): a bootstrap spec is exactly the resolved def's pickup
// contract, with no tier/origin label gating it.
export type AppLoopBootstrapSpec = PickupContractV2;

export type AppBootstrapPrOwnership =
  | { kind: 'none' }
  | { kind: 'known'; number: number }
  | { kind: 'ambiguous'; marker: string; absentChecks?: number };

export interface AppLoopBootstrapOwnership {
  base: string;
  branch: string;
  ownedOid: string | null;
  pr: AppBootstrapPrOwnership;
}

export type AppLoopBootstrapResult =
  | { ok: true; identity: AppLoopBootstrap; ownership: AppLoopBootstrapOwnership }
  | { ok: false; kind: 'conflict'; conflict: AppBootstrapConflictTarget }
  | {
      ok: false;
      kind: 'error';
      error: string;
      requiresAttention?: true;
      recovery?: AppLoopBootstrapOwnership;
    };

export function resolveAppGateRefs(
  flowRefs: FlowRefs | undefined,
  trustedBootstrap: AppLoopBootstrap | null,
): AppGateRefs {
  if (trustedBootstrap !== null) {
    return { pr: trustedBootstrap.pr, ticket: trustedBootstrap.issue, bootstrap: trustedBootstrap };
  }
  return {
    pr: flowRefs?.pr ?? null,
    ticket: flowRefs?.ticket ?? null,
    bootstrap: null,
  };
}

/** §27.10 */
export function resolvePickupBranch(record: PickupRecord, trustedBootstrap: AppLoopBootstrap | null, flowTicket: number | null): PickupBranch {
  if (record.kind === 'invalid') return { kind: 'unreadable', detail: record.detail };
  if (trustedBootstrap !== null) return { kind: 'branch', branch: trustedBootstrap.branch };
  return record.kind === 'complete' && record.bootstrap.issue === flowTicket ? { kind: 'branch', branch: record.bootstrap.branch } : { kind: 'none' };
}

const SAFE_BRANCH = /^[A-Za-z0-9._/][A-Za-z0-9._/-]*$/;

async function bestEffort(op: () => Promise<void>): Promise<void> {
  try {
    await op();
  } catch {
    // §27.13
  }
}

async function compensateBootstrapOwnership(
  deps: Pick<AppLoopBootstrapDeps, 'git' | 'github'>,
  ownership: AppLoopBootstrapOwnership,
): Promise<
  | { ok: true }
  | { ok: false; error: string; recovery?: AppLoopBootstrapOwnership }
> {
  const recovery: AppLoopBootstrapOwnership = { ...ownership, pr: { ...ownership.pr } };
  if (recovery.pr.kind === 'ambiguous') {
    let reconciled: Awaited<ReturnType<AppBootstrapGitHub['findOwnedOpenPr']>>;
    try {
      reconciled = await deps.github.findOwnedOpenPr({
        base: recovery.base,
        head: recovery.branch,
        marker: recovery.pr.marker,
      });
    } catch (e) {
      return {
        ok: false,
        error: `could not reconcile draft PR creation: ${errMsg(e)}`,
        recovery,
      };
    }
    if (reconciled.kind === 'foreign') {
      return {
        ok: false,
        error: `draft PR outcome conflicts with another open PR for ${recovery.branch}`,
        recovery,
      };
    }
    if (reconciled.kind === 'owned') {
      recovery.pr = { kind: 'known', number: reconciled.number };
    } else {
      const absentChecks = recovery.pr.absentChecks ?? 0;
      if (absentChecks < 1) {
        recovery.pr = {
          kind: 'ambiguous',
          marker: recovery.pr.marker,
          absentChecks: absentChecks + 1,
        };
        return {
          ok: false,
          error: `draft PR absence is not yet stable for ${recovery.branch}`,
          recovery,
        };
      }
      recovery.pr = { kind: 'none' };
    }
  }
  if (recovery.pr.kind === 'known') {
    const number = recovery.pr.number;
    try {
      await deps.github.closePr(number);
      recovery.pr = { kind: 'none' };
    } catch (e) {
      return {
        ok: false,
        error: `could not close draft PR ${number}: ${errMsg(e)}`,
        recovery,
      };
    }
  }
  try {
    await deps.git.rollbackCreatedBranch(recovery.branch, recovery.ownedOid);
  } catch (e) {
    return {
      ok: false,
      error: `could not roll back branch ${recovery.branch}: ${errMsg(e)}`,
      ...(e instanceof UnresolvedRemoteBootstrapBranchError ? {} : { recovery }),
    };
  }
  return { ok: true };
}

export async function runAppLoopBootstrap(
  deps: AppLoopBootstrapDeps,
  req: AppLoopBootstrapRequest,
): Promise<AppLoopBootstrapResult> {
  const fail = (
    error: string,
    recovery?: AppLoopBootstrapOwnership,
  ): AppLoopBootstrapResult =>
    recovery === undefined
      ? { ok: false, kind: 'error', error }
      : { ok: false, kind: 'error', error, requiresAttention: true, recovery };
  if (!Number.isSafeInteger(req.issue) || req.issue <= 0) return fail('pickup requires a positive GitHub issue number');
  if (req.spec.initialStatus.trim().length === 0) return fail('pickup requires a non-blank initial status');
  const branch = req.spec.branchTemplate.replaceAll('{issue}', String(req.issue));
  if (!SAFE_BRANCH.test(branch)) return fail(`unsafe branch name from branch_template: ${branch}`);
  const confirmedWipe = req.confirmedWipe;
  // The policy that authorizes the deletion is re-read here, at the destructive operation, rather than
  // trusted from the prompt that produced this confirmation (§27.10).
  if (confirmedWipe !== undefined) {
    if (req.spec.wipe.mode !== 'wipe-and-retry') {
      return fail('pickup has no wipe policy authorizing branch deletion');
    }
    if (confirmedWipe.branch !== branch) {
      return fail(`wipe confirmation names a different branch: ${confirmedWipe.branch}`);
    }
  }
  let createdBranch: string | null = null;
  let createdBase: string | null = null;
  let ownedOid: string | null = null;
  let createdPr: number | null = null;
  let prOwnership: AppBootstrapPrOwnership = { kind: 'none' };
  const prMarker = `<!-- agent-terminal-bootstrap:${randomUUID()} -->`;
  try {
    if (!(await deps.git.isCleanTree())) return fail('working tree is not clean');
    const base = await deps.git.resolveBaseBranch();
    if (!base) return fail('could not resolve base branch');
    if (branch === base) {
      return fail(`refused a pickup onto the repository default branch: ${branch}`);
    }
    const conflict = await deps.conflicts.inspect(branch);
    if (confirmedWipe !== undefined) {
      if (!sameAppBootstrapConflictTarget(conflict, confirmedWipe)) {
        if (hasAppBootstrapConflict(conflict)) return { ok: false, kind: 'conflict', conflict };
        return fail(`conflicting resources changed for branch ${branch}`);
      }
      await deps.conflicts.wipe(confirmedWipe);
    } else if (hasAppBootstrapConflict(conflict)) {
      if (req.spec.wipe.mode === 'wipe-and-retry') {
        return { ok: false, kind: 'conflict', conflict };
      }
      return fail(`branch ${branch} already exists`);
    }

    deps.prepareBootstrap({ branch, issue: req.issue, initialStatus: req.spec.initialStatus });
    try {
      await deps.git.createBranchFromBase(branch, base);
      createdBranch = branch;
      createdBase = base;
    } catch (e) {
      if (e instanceof OwnedBootstrapBranchError) {
        createdBranch = branch;
        createdBase = base;
      }
      throw e;
    }
    const issue = await deps.github.viewIssue(req.issue);
    const seeLine = issue?.url ? `\n\nSee ${issue.url}` : '';
    ownedOid = await deps.git.commitEmptyStart(`[skip ci] start work on #${req.issue}${seeLine}`);
    await deps.git.pushBranchUpstream(branch, ownedOid);

    const title = `${issue?.title ?? `issue #${req.issue}`} (closes #${req.issue})`;
    const body = `closes #${req.issue}\n\n${prMarker}\n`;
    try {
      createdPr = await deps.github.createDraftPr({ base, head: branch, title, body });
      prOwnership = { kind: 'known', number: createdPr };
    } catch (createError) {
      if (createError instanceof AmbiguousBootstrapOperationError) {
        prOwnership = { kind: 'ambiguous', marker: prMarker };
      }
      throw createError;
    }
    const identity = {
      pr: createdPr,
      branch,
      issue: req.issue,
      initialStatus: req.spec.initialStatus,
    };
    deps.writeBootstrap(identity);

    return {
      ok: true,
      identity,
      ownership: {
        base,
        branch,
        ownedOid,
        pr: prOwnership,
      },
    };
  } catch (e) {
    const error = errMsg(e);
    if (createdBranch === null || createdBase === null) return fail(error);
    const recovery: AppLoopBootstrapOwnership = {
      base: createdBase,
      branch: createdBranch,
      ownedOid,
      pr: prOwnership,
    };
    const compensation = await compensateBootstrapOwnership(deps, recovery);
    if (compensation.ok) return fail(error);
    const combined = `${error}; ${compensation.error}`;
    return compensation.recovery === undefined
      ? { ok: false, kind: 'error', error: combined, requiresAttention: true }
      : fail(combined, compensation.recovery);
  }
}

export interface AppLoopBootstrapSession {
  run(request: AppLoopBootstrapRequest): Promise<AppLoopBootstrapResult>;
  compensate(ownership: AppLoopBootstrapOwnership): Promise<void>;
  finalize(request: AppLoopBootstrapRequest, identity: AppLoopBootstrap): Promise<void>;
}

export function createAppLoopBootstrapSession(
  deps: AppLoopBootstrapDeps,
): AppLoopBootstrapSession {
  type PendingRecovery = {
    ownership: AppLoopBootstrapOwnership;
    clearBootstrapAfterRecovery: boolean;
  };
  let pendingRecovery: PendingRecovery | null = null;
  const recover = async (): Promise<void> => {
    if (pendingRecovery === null) return;
    const pending = pendingRecovery;
    const compensation = await compensateBootstrapOwnership(deps, pending.ownership);
    if (!compensation.ok) {
      pendingRecovery =
        compensation.recovery === undefined
          ? null
          : {
              ownership: compensation.recovery,
              clearBootstrapAfterRecovery: pending.clearBootstrapAfterRecovery,
            };
      if (compensation.recovery === undefined) {
        if (pending.clearBootstrapAfterRecovery) deps.clearBootstrap();
      }
      throw new Error(compensation.error);
    }
    pendingRecovery = null;
    if (pending.clearBootstrapAfterRecovery) deps.clearBootstrap();
  };
  return {
    async run(request) {
      try {
        await recover();
      } catch (e) {
        return {
          ok: false,
          kind: 'error' as const,
          error: `pending bootstrap cleanup failed: ${errMsg(e)}`,
          requiresAttention: true,
          ...(pendingRecovery === null
            ? {}
            : { recovery: pendingRecovery.ownership }),
        };
      }
      const result = await runAppLoopBootstrap(deps, request);
      if (!result.ok && result.kind === 'error' && result.recovery !== undefined) {
        pendingRecovery = {
          ownership: result.recovery,
          clearBootstrapAfterRecovery: false,
        };
      }
      return result;
    },
    async compensate(ownership) {
      const compensation = await compensateBootstrapOwnership(deps, ownership);
      if (!compensation.ok) {
        pendingRecovery =
          compensation.recovery === undefined
            ? null
            : {
                ownership: compensation.recovery,
                clearBootstrapAfterRecovery: true,
              };
        if (compensation.recovery === undefined) deps.clearBootstrap();
        throw new Error(compensation.error);
      }
      deps.clearBootstrap();
    },
    async finalize(request, identity) {
      await bestEffort(() => deps.github.assignIssueToSelf(request.issue));
      for (const label of request.spec.initialLabels) {
        if (label.target === 'issue') {
          await bestEffort(() =>
            deps.github.setIssueLabel(request.issue, label.label, label.action === 'add'),
          );
        }
      }
      for (const label of request.spec.initialLabels) {
        if (label.target === 'pr') {
          await bestEffort(() =>
            deps.github.setPrLabel(identity.pr, label.label, label.action === 'add'),
          );
        }
      }
    },
  };
}

export interface AppLoopBootstrapJob {
  repoDir: string;
  loopName: string;
  stepId: string;
  entryToken: number;
  issue: number | null;
  entry: AppLoopEntry;
  // §28.4 D1 — the impl-slice this work turn is for (the flow's `currentSlice`, default 1). The engine keys
  // the turn's result artifact off it (`red-result.slice-N.md`) so a loop-back re-entry writes fresh.
  slice?: number;
  bootstrap: AppLoopBootstrapSpec | null;
  // §B.5 item 6 / AC10: present when the step's bound def declares a `pickup:` block AND carries a skill —
  // the coordinator injects it AFTER work entry is accepted so it is submitted ahead of the boundary
  // preamble (CWE-74). Absent when the def declares no `pickup:` block (the seam injects it) or has no skill.
  skill?: string;
}

export interface AppLoopBootstrapCoordinatorDeps {
  run(repoDir: string, request: AppLoopBootstrapRequest): Promise<AppLoopBootstrapResult>;
  compensateBootstrap(job: AppLoopBootstrapJob, ownership: AppLoopBootstrapOwnership): Promise<void>;
  finalizeBootstrap(job: AppLoopBootstrapJob, identity: AppLoopBootstrap): Promise<void>;
  hasBootstrapForJob(job: AppLoopBootstrapJob): boolean;
  isCurrentJob(job: AppLoopBootstrapJob): boolean;
  canEnterWork(job: AppLoopBootstrapJob): boolean;
  acceptBootstrap(job: AppLoopBootstrapJob, identity: AppLoopBootstrap): void;
  rollbackStep(job: AppLoopBootstrapJob): boolean;
  enterWork(
    repoDir: string,
    loopName: string,
    stepId: string,
    entry: AppLoopEntry,
    deferRequest: boolean,
    slice?: number,
  ): AppLoopEnterResult;
  /** Inject the job's (already-collapsed) skill line, submitted, calling `onComplete` once its submit `\r`
   *  has been written (§B.13c). The deferred work turn chains off that signal (§B.5 item 6, AC10). */
  inject(text: string, onComplete: () => void): void;
  /** True iff the shell is mid-command (§19.3): the skill is refused rather than typed into live stdin. */
  isShellBusy(): boolean;
  /** Surface a transient §19.3 notice on a later state push — distinct from `emitError`'s blocking dialog,
   *  because a refusal on a step whose work turn is running fine is not an error (§B.5 item 6). */
  emitNotice(notice: { repoDir: string; stepId: string; notice: string }): void;
  /** Fire the work turn that `enterWork(…, true)` accepted but did not request — the engine requests it
   *  now, chaining its boundary strictly after the skill's submit (§B.20a). */
  triggerWork(job: AppLoopBootstrapJob): void;
  /** Abandon a deferred-but-never-triggered work turn, freeing the runner (§B.20a). */
  cancelWork(job: AppLoopBootstrapJob): void;
  /** Arm the deferral deadline: `onLapse` fires if the injection never signals completion; the returned
   *  canceller is invoked when completion does arrive (CWE-755 — never leave a turn accepted-but-unrequested). */
  armDeferDeadline(onLapse: () => void): () => void;
  emitError(error: { repoDir: string; stepId: string; reason: string }): void;
  emitConflict(
    conflict: { repoDir: string; stepId: string } & AppBootstrapConflictTarget,
  ): void;
  audit(repoDir: string, kind: AppBootstrapAuditKind, stepId: string, detail?: string): void;
}

export interface AppLoopBootstrapCoordinator {
  enter(job: AppLoopBootstrapJob): void;
  resolve(
    repoDir: string,
    stepId: string,
    wipe: boolean,
    target: AppBootstrapConflictTarget,
  ): void;
}

export function createAppLoopBootstrapCoordinator(
  deps: AppLoopBootstrapCoordinatorDeps,
): AppLoopBootstrapCoordinator {
  let inFlight: { token: symbol; job: AppLoopBootstrapJob } | null = null;
  const pending = new Map<
    string,
    { job: AppLoopBootstrapJob; confirmedWipe?: AppBootstrapConflictTarget }
  >();
  const held = new Map<
    string,
    { job: AppLoopBootstrapJob; target: AppBootstrapConflictTarget }
  >();
  const heldKey = (repoDir: string, stepId: string): string => `${repoDir}\0${stepId}`;
  const callEnterWork = (job: AppLoopBootstrapJob, deferRequest: boolean): AppLoopEnterResult =>
    deps.enterWork(job.repoDir, job.loopName, job.stepId, job.entry, deferRequest, job.slice);
  const audit = (job: AppLoopBootstrapJob, kind: AppBootstrapAuditKind, detail?: string): void => {
    try {
      if (detail === undefined) deps.audit(job.repoDir, kind, job.stepId);
      else deps.audit(job.repoDir, kind, job.stepId, detail);
    } catch {}
  };
  const emitError = (job: AppLoopBootstrapJob, reason: string): void => {
    try {
      deps.emitError({ repoDir: job.repoDir, stepId: job.stepId, reason });
    } catch {}
  };
  const emitNotice = (job: AppLoopBootstrapJob, notice: string): void => {
    try {
      deps.emitNotice({ repoDir: job.repoDir, stepId: job.stepId, notice });
    } catch {}
  };
  const emitConflict = (
    job: AppLoopBootstrapJob,
    target: AppBootstrapConflictTarget,
  ): void => {
    try {
      deps.emitConflict({ repoDir: job.repoDir, stepId: job.stepId, ...target });
    } catch {}
  };
  const acquire = (job: AppLoopBootstrapJob): symbol => {
    const token = Symbol(`${job.stepId}:${job.entryToken}`);
    inFlight = { token, job };
    return token;
  };
  const release = (job: AppLoopBootstrapJob, token: symbol): boolean => {
    if (inFlight?.token !== token || inFlight.job !== job) return false;
    inFlight = null;
    return true;
  };
  const owns = (job: AppLoopBootstrapJob, token: symbol): boolean =>
    inFlight?.token === token && inFlight.job === job;
  const rollbackJob = (job: AppLoopBootstrapJob, reason: string): void => {
    try {
      if (!deps.rollbackStep(job)) {
        audit(job, 'stale');
        return;
      }
      audit(job, 'rollback', reason);
      emitError(job, reason);
    } catch (e) {
      const combined = `${reason}; could not roll back step ${job.stepId}: ${errMsg(e)}`;
      audit(job, 'rollback-failed', combined);
      emitError(job, combined);
    }
  };
  // §B.5 item 6 / §B.20a: the turn was accepted-but-not-requested; inject the step's skill and chain its
  // request off the injection's completion, so the repo-authored skill line is submitted before any boundary
  // preamble (CWE-74). A deadline guards the gap: if completion never signals, revert rather than leave the
  // step in_progress with a turn that occupies the runner but is never requested (CWE-755).
  const handoffSkill = (job: AppLoopBootstrapJob, skill: string): void => {
    let fired = false;
    const cancelDeadline = deps.armDeferDeadline(() => {
      if (fired) return;
      fired = true;
      const reason = `the work turn for step ${job.stepId} was never requested: its skill injection did not complete in time`;
      audit(job, 'failure', reason);
      try {
        deps.cancelWork(job);
      } catch {}
      rollbackJob(job, reason);
    });
    try {
      deps.inject(skill, () => {
        if (fired) return;
        fired = true;
        try {
          cancelDeadline();
        } catch {}
        try {
          deps.triggerWork(job);
        } catch (e) {
          const reason = `could not start the work turn for step ${job.stepId}: ${errMsg(e)}`;
          audit(job, 'failure', reason);
          try {
            deps.cancelWork(job);
          } catch {}
          rollbackJob(job, reason);
        }
      });
    } catch (e) {
      if (fired) return;
      fired = true;
      try {
        cancelDeadline();
      } catch {}
      const reason = `could not inject the skill for step ${job.stepId}: ${errMsg(e)}`;
      audit(job, 'failure', reason);
      try {
        deps.cancelWork(job);
      } catch {}
      rollbackJob(job, reason);
    }
  };
  // §B.5 item 6: a bound def declaring a `pickup:` block has its skill injected AFTER work entry is
  // accepted, not at the seam — so no synchronous revert arm below the injection can roll back a step whose
  // agent turn is already live. Over a busy shell (§19.3) the skill is refused and BUSY_NOTICE surfaced, and
  // the turn starts on the synchronous arm instead (item 4's no-injection case).
  const enterWorkForJob = (job: AppLoopBootstrapJob): AppLoopEnterResult => {
    const skill = job.skill;
    const hasSkill = typeof skill === 'string' && skill.length > 0;
    let busy = false;
    if (hasSkill) {
      try {
        busy = deps.isShellBusy();
      } catch {
        busy = true;
      }
    }
    const defer = hasSkill && !busy;
    const result = callEnterWork(job, defer);
    if (result !== 'entered') return result;
    if (defer) handoffSkill(job, skill as string);
    else if (hasSkill && busy) emitNotice(job, BUSY_NOTICE);
    return result;
  };
  type CurrentJobStatus =
    | { kind: 'current' }
    | { kind: 'stale' }
    | { kind: 'failed'; reason: string };
  const currentStatus = (job: AppLoopBootstrapJob): CurrentJobStatus => {
    try {
      return deps.isCurrentJob(job) ? { kind: 'current' } : { kind: 'stale' };
    } catch (e) {
      return {
        kind: 'failed',
        reason: `could not verify bootstrap step ${job.stepId}: ${errMsg(e)}`,
      };
    }
  };
  const rollbackUnverifiableJob = (job: AppLoopBootstrapJob, reason: string): void => {
    audit(job, 'failure', reason);
    rollbackJob(job, reason);
  };
  type WorkEntryReadiness =
    | { kind: 'ready' }
    | { kind: 'busy' }
    | { kind: 'failed'; reason: string };
  const workEntryReadiness = (job: AppLoopBootstrapJob): WorkEntryReadiness => {
    try {
      return deps.canEnterWork(job) ? { kind: 'ready' } : { kind: 'busy' };
    } catch (e) {
      return {
        kind: 'failed',
        reason: `could not verify work-entry readiness for step ${job.stepId}: ${errMsg(e)}`,
      };
    }
  };
  const requireWorkEntryReadiness = (
    job: AppLoopBootstrapJob,
    busyReason: string,
  ): boolean => {
    const readiness = workEntryReadiness(job);
    if (readiness.kind === 'ready') return true;
    const reason = readiness.kind === 'failed' ? readiness.reason : busyReason;
    audit(job, 'failure', reason);
    rollbackJob(job, reason);
    return false;
  };
  const stale = async (job: AppLoopBootstrapJob, result: AppLoopBootstrapResult): Promise<void> => {
    audit(job, 'stale');
    if (result.ok) {
      try {
        await deps.compensateBootstrap(job, result.ownership);
        emitError(
          job,
          `Bootstrap completed after step ${job.stepId} was no longer current; its draft PR and branch were removed.`,
        );
      } catch (e) {
        emitError(
          job,
          `Bootstrap cleanup needs attention after step ${job.stepId} was no longer current: ${errMsg(e)}`,
        );
      }
    } else if (result.kind === 'error' && result.requiresAttention) {
      emitError(job, `Bootstrap cleanup needs attention after step ${job.stepId} was no longer current: ${result.error}`);
    }
  };
  const workEntryReason = (result: AppLoopEnterResult): string =>
    result === 'busy'
      ? 'the app loop runner is busy'
      : 'the app loop definition no longer resolves';
  const enterFastPath = (job: AppLoopBootstrapJob): void => {
    if (!requireWorkEntryReadiness(
      job,
      `could not enter work for step ${job.stepId}: the app loop runner is busy`,
    )) {
      return;
    }
    let result: AppLoopEnterResult;
    try {
      result = enterWorkForJob(job);
    } catch (e) {
      const reason = `could not enter work for step ${job.stepId}: ${errMsg(e)}`;
      audit(job, 'failure', reason);
      rollbackJob(job, reason);
      return;
    }
    if (result !== 'entered') {
      const reason = `could not enter work for step ${job.stepId}: ${workEntryReason(result)}`;
      audit(job, 'failure', reason);
      rollbackJob(job, reason);
    }
  };

  let dispatchJob: (
    job: AppLoopBootstrapJob,
    confirmedWipe?: AppBootstrapConflictTarget,
  ) => void;
  const start = (
    job: AppLoopBootstrapJob,
    confirmedWipe?: AppBootstrapConflictTarget,
  ): void => {
    const bootstrap = job.bootstrap;
    if (bootstrap === null) {
      enterFastPath(job);
      return;
    }
    const status = currentStatus(job);
    if (status.kind === 'failed') {
      rollbackUnverifiableJob(job, status.reason);
      return;
    }
    if (status.kind === 'stale') return;
    if (!requireWorkEntryReadiness(
      job,
      `could not start bootstrap for step ${job.stepId}: the app loop runner is busy`,
    )) {
      return;
    }
    const token = acquire(job);
    audit(job, 'start');
    const finish = (): void => {
      while (inFlight === null) {
        const nextEntry = pending.entries().next();
        if (nextEntry.done) return;
        const [repoDir, next] = nextEntry.value;
        pending.delete(repoDir);
        dispatchJob(next.job, next.confirmedWipe);
      }
    };
    const resolve = async (result: AppLoopBootstrapResult): Promise<void> => {
      if (!owns(job, token)) return;
      try {
        const status = currentStatus(job);
        if (status.kind === 'stale') {
          await stale(job, result);
          return;
        }
        if (status.kind === 'failed') {
          audit(job, 'failure', status.reason);
          let reason = status.reason;
          if (result.ok) {
            try {
              await deps.compensateBootstrap(job, result.ownership);
            } catch (e) {
              reason = `${reason}; bootstrap cleanup failed: ${errMsg(e)}`;
            }
          } else if (result.kind === 'error' && result.requiresAttention) {
            reason = `${reason}; bootstrap cleanup needs attention: ${result.error}`;
          }
          rollbackJob(job, reason);
          return;
        }
        if (result.ok) {
          let entryResult: AppLoopEnterResult;
          try {
            entryResult = enterWorkForJob(job);
          } catch (e) {
            const reason = `bootstrap succeeded but work entry failed: ${errMsg(e)}`;
            audit(job, 'failure', reason);
            try {
              await deps.compensateBootstrap(job, result.ownership);
            } catch (cleanupError) {
              rollbackJob(job, `${reason}; bootstrap cleanup failed: ${errMsg(cleanupError)}`);
              return;
            }
            rollbackJob(job, reason);
            return;
          }
          if (entryResult !== 'entered') {
            const reason = `bootstrap succeeded but work entry was refused: ${workEntryReason(entryResult)}`;
            audit(job, 'failure', reason);
            try {
              await deps.compensateBootstrap(job, result.ownership);
            } catch (cleanupError) {
              rollbackJob(job, `${reason}; bootstrap cleanup failed: ${errMsg(cleanupError)}`);
              return;
            }
            rollbackJob(job, reason);
            return;
          }
          deps.acceptBootstrap(job, result.identity);
          await deps.finalizeBootstrap(job, result.identity);
          audit(job, 'success', result.identity.branch);
          return;
        }
        // Nothing destructive has happened yet: the step stays put and the operator decides. Releasing
        // the in-flight slot below is what keeps another repo from queueing behind an unanswered dialog.
        if (result.kind === 'conflict') {
          held.set(heldKey(job.repoDir, job.stepId), { job, target: result.conflict });
          audit(job, 'conflict', result.conflict.branch);
          emitConflict(job, result.conflict);
          return;
        }
        audit(job, 'failure', result.error);
        rollbackJob(job, result.error);
      } catch (e) {
        const reason = `bootstrap completion failed for step ${job.stepId}: ${errMsg(e)}`;
        audit(job, 'failure', reason);
        emitError(job, reason);
      } finally {
        release(job, token);
        finish();
      }
    };
    let operation: Promise<AppLoopBootstrapResult>;
    try {
      operation =
        job.issue === null
          ? Promise.resolve<AppLoopBootstrapResult>({
              ok: false,
              kind: 'error',
              error: 'pickup requires a resolved GitHub ticket input',
            })
          : deps.run(job.repoDir, {
              issue: job.issue,
              spec: bootstrap,
              ...(confirmedWipe === undefined ? {} : { confirmedWipe }),
            });
    } catch (e) {
      operation = Promise.resolve({ ok: false, kind: 'error', error: errMsg(e) });
    }
    void operation.then(
      (result) => void resolve(result),
      (e: unknown) => void resolve({ ok: false, kind: 'error', error: errMsg(e) }),
    );
  };

  dispatchJob = (job, confirmedWipe) => {
    if (inFlight !== null) {
      if (
        inFlight.job.repoDir !== job.repoDir ||
        inFlight.job.entryToken !== job.entryToken
      ) {
        pending.set(job.repoDir, { job, confirmedWipe });
      }
      return;
    }
    const status = currentStatus(job);
    if (status.kind === 'failed') {
      rollbackUnverifiableJob(job, status.reason);
      return;
    }
    if (status.kind === 'stale') {
      audit(job, 'stale');
      return;
    }
    if (job.bootstrap === null) {
      enterFastPath(job);
      return;
    }
    if (confirmedWipe === undefined && job.issue !== null && deps.hasBootstrapForJob(job)) {
      enterFastPath(job);
      return;
    }
    start(job, confirmedWipe);
  };

  const declineWipe = (job: AppLoopBootstrapJob): void => {
    try {
      if (!deps.rollbackStep(job)) {
        audit(job, 'stale');
        return;
      }
      audit(job, 'rollback', 'operator declined branch wipe');
    } catch (e) {
      const reason = `could not roll back step ${job.stepId} after a declined wipe: ${errMsg(e)}`;
      audit(job, 'rollback-failed', reason);
      emitError(job, reason);
    }
  };

  return {
    enter: (job) => dispatchJob(job),
    resolve(repoDir, stepId, wipe, target) {
      const key = heldKey(repoDir, stepId);
      const conflict = held.get(key);
      if (conflict === undefined) return;
      if (!sameAppBootstrapConflictTarget(conflict.target, target)) return;
      held.delete(key);
      const status = currentStatus(conflict.job);
      if (status.kind === 'failed') {
        rollbackUnverifiableJob(conflict.job, status.reason);
        return;
      }
      if (status.kind === 'stale') {
        audit(conflict.job, 'stale');
        return;
      }
      if (wipe) {
        audit(conflict.job, 'wipe', conflict.target.branch);
        dispatchJob(conflict.job, conflict.target);
        return;
      }
      audit(conflict.job, 'decline', conflict.target.branch);
      declineWipe(conflict.job);
    },
  };
}
