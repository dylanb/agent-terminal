import type { AppLoopEntry } from './appLoopEngine';
import type { AppLoopBootstrap } from './appLoopState';
import type {
  AppBootstrapConflicts,
  BootstrapGit,
  BootstrapGitHub,
} from './bootstrapPorts';
import { errMsg } from './errno';
import type { AppBootstrapAuditKind } from '../shared/audit';
import {
  hasAppBootstrapConflict,
  sameAppBootstrapConflictTarget,
  type AppBootstrapConflictTarget,
  type AppBootstrapLabelMutation,
  type AppBootstrapWipePolicy,
} from '../shared/appBootstrap';

export interface AppLoopBootstrapDeps {
  git: BootstrapGit;
  github: BootstrapGitHub;
  conflicts: AppBootstrapConflicts;
  rollbackCreatedBranch(branch: string): Promise<void>;
  writeBootstrap(identity: AppLoopBootstrap): void;
}

export interface AppLoopBootstrapRequest {
  issue: number;
  spec: AppLoopBootstrapSpec;
  confirmedWipe?: AppBootstrapConflictTarget;
}

export interface AppLoopBootstrapSpec {
  origin: 'operator' | 'app-bundled' | 'repo';
  branchTemplate: string;
  wipe: AppBootstrapWipePolicy;
  initialLabels: AppBootstrapLabelMutation[];
}

export type AppLoopBootstrapResult =
  | { kind: 'success'; identity: AppLoopBootstrap }
  | { kind: 'error'; error: string }
  | { kind: 'conflict'; conflict: AppBootstrapConflictTarget };

const SAFE_BRANCH = /^[A-Za-z0-9._/][A-Za-z0-9._/-]*$/;

async function bestEffort(op: () => Promise<void>): Promise<void> {
  try {
    await op();
  } catch {
    // §27.13
  }
}

export async function runAppLoopBootstrap(
  deps: AppLoopBootstrapDeps,
  req: AppLoopBootstrapRequest,
): Promise<AppLoopBootstrapResult> {
  const fail = (error: string): AppLoopBootstrapResult => ({
    kind: 'error',
    error,
  });
  if (req.spec.origin !== 'operator') {
    return fail(`refused bootstrap from a non-operator-authored loop def (origin: ${req.spec.origin})`);
  }
  if (!Number.isSafeInteger(req.issue) || req.issue <= 0) return fail('pickup requires a positive GitHub issue number');
  const branch = req.spec.branchTemplate.replaceAll('{issue}', String(req.issue));
  if (!SAFE_BRANCH.test(branch)) return fail(`unsafe branch name from branch_template: ${branch}`);
  if (req.confirmedWipe !== undefined) {
    if (req.spec.wipe.mode !== 'wipe-and-retry') {
      return fail('pickup has no wipe policy authorizing branch deletion');
    }
    if (req.confirmedWipe.branch !== branch) {
      return fail(`wipe confirmation names a different branch: ${req.confirmedWipe.branch}`);
    }
  }
  let createdBranch: string | null = null;
  try {
    if (!(await deps.git.isCleanTree())) return fail('working tree is not clean');
    const base = await deps.git.resolveBaseBranch();
    if (!base) return fail('could not resolve base branch');
    const conflict = await deps.conflicts.inspect(branch);
    if (req.confirmedWipe !== undefined) {
      if (!sameAppBootstrapConflictTarget(conflict, req.confirmedWipe)) {
        if (hasAppBootstrapConflict(conflict)) {
          return { kind: 'conflict', conflict };
        }
        return fail(`conflicting resources changed for branch ${branch}`);
      }
      await deps.conflicts.wipe(req.confirmedWipe);
    } else if (hasAppBootstrapConflict(conflict)) {
      if (req.spec.wipe.mode === 'wipe-and-retry') {
        return { kind: 'conflict', conflict };
      }
      return fail(`branch ${branch} already exists`);
    }

    await deps.git.createBranchFromBase(branch, base);
    createdBranch = branch;
    const issue = await deps.github.viewIssue(req.issue);
    const seeLine = issue?.url ? `\n\nSee ${issue.url}` : '';
    await deps.git.commitEmptyStart(`[skip ci] start work on #${req.issue}${seeLine}`);
    await deps.git.pushBranchUpstream(branch);

    await bestEffort(() => deps.github.assignIssueToSelf(req.issue));
    for (const label of req.spec.initialLabels) {
      if (label.target === 'issue') {
        await bestEffort(() => deps.github.setIssueLabel(req.issue, label.label, label.action === 'add'));
      }
    }

    const title = `${issue?.title ?? `issue #${req.issue}`} (closes #${req.issue})`;
    const body = `closes #${req.issue}\n`;
    const pr = await deps.github.createDraftPr({ base, head: branch, title, body });
    if (pr === null) throw new Error('draft PR creation failed');
    for (const label of req.spec.initialLabels) {
      if (label.target === 'pr') {
        await bestEffort(() => deps.github.setPrLabel(pr, label.label, label.action === 'add'));
      }
    }
    const identity = { pr, branch, issue: req.issue };
    deps.writeBootstrap(identity);
    return { kind: 'success', identity };
  } catch (e) {
    const error = errMsg(e);
    if (createdBranch !== null) {
      try {
        await deps.rollbackCreatedBranch(createdBranch);
      } catch (rollbackError) {
        return fail(`${error}; could not roll back branch ${createdBranch}: ${errMsg(rollbackError)}`);
      }
    }
    return fail(error);
  }
}

export interface AppLoopBootstrapJob {
  repoDir: string;
  loopName: string;
  stepId: string;
  issue: number | null;
  entry: AppLoopEntry;
  bootstrap: AppLoopBootstrapSpec | null;
}

export interface AppLoopBootstrapCoordinatorDeps {
  run(repoDir: string, request: AppLoopBootstrapRequest): Promise<AppLoopBootstrapResult>;
  hasBootstrapForIssue(repoDir: string, issue: number): boolean;
  isCurrentStep(repoDir: string, stepId: string): boolean;
  rollbackStep(repoDir: string, stepId: string): boolean;
  enterWork(repoDir: string, loopName: string, stepId: string, entry: AppLoopEntry): void;
  emitError(error: { repoDir: string; stepId: string; reason: string }): void;
  emitConflict(
    conflict: { repoDir: string; stepId: string } & AppBootstrapConflictTarget,
  ): void;
  audit(repoDir: string, kind: AppBootstrapAuditKind, stepId: string, detail?: string): void;
}

export interface AppLoopBootstrapCoordinator {
  enter(job: AppLoopBootstrapJob): void;
  resolve(repoDir: string, stepId: string, wipe: boolean): void;
}

export function createAppLoopBootstrapCoordinator(
  deps: AppLoopBootstrapCoordinatorDeps,
): AppLoopBootstrapCoordinator {
  const pending = new Map<
    string,
    { job: AppLoopBootstrapJob; target: AppBootstrapConflictTarget }
  >();
  const pendingKey = (repoDir: string, stepId: string): string => `${repoDir}\0${stepId}`;
  const enterWork = (job: AppLoopBootstrapJob): void =>
    deps.enterWork(job.repoDir, job.loopName, job.stepId, job.entry);

  const handle = (job: AppLoopBootstrapJob, result: AppLoopBootstrapResult): void => {
    if (!deps.isCurrentStep(job.repoDir, job.stepId)) {
      deps.audit(job.repoDir, 'stale', job.stepId);
      return;
    }
    switch (result.kind) {
      case 'success':
        deps.audit(job.repoDir, 'success', job.stepId, result.identity.branch);
        enterWork(job);
        return;
      case 'conflict':
        pending.set(pendingKey(job.repoDir, job.stepId), {
          job,
          target: result.conflict,
        });
        deps.audit(job.repoDir, 'conflict', job.stepId, result.conflict.branch);
        deps.emitConflict({
          repoDir: job.repoDir,
          stepId: job.stepId,
          ...result.conflict,
        });
        return;
      case 'error':
        deps.audit(job.repoDir, 'failure', job.stepId, result.error);
        if (!deps.rollbackStep(job.repoDir, job.stepId)) {
          deps.audit(job.repoDir, 'stale', job.stepId);
          return;
        }
        deps.audit(job.repoDir, 'rollback', job.stepId, result.error);
        deps.emitError({
          repoDir: job.repoDir,
          stepId: job.stepId,
          reason: result.error,
        });
    }
  };

  const run = (
    job: AppLoopBootstrapJob,
    confirmedWipe?: AppBootstrapConflictTarget,
  ): void => {
    const bootstrap = job.bootstrap;
    let operation: Promise<AppLoopBootstrapResult>;
    if (bootstrap === null) {
      operation = Promise.resolve({
        kind: 'error',
        error: 'pickup bootstrap is missing',
      });
    } else if (job.issue === null) {
      operation = Promise.resolve({
        kind: 'error',
        error: 'pickup requires a resolved GitHub ticket input',
      });
    } else {
      operation = deps.run(job.repoDir, {
        issue: job.issue,
        spec: bootstrap,
        ...(confirmedWipe ? { confirmedWipe } : {}),
      });
    }
    void operation.then(
      (result) => handle(job, result),
      (e: unknown) => handle(job, { kind: 'error', error: errMsg(e) }),
    );
  };

  return {
    enter(job) {
      if (job.bootstrap === null) {
        enterWork(job);
        return;
      }
      if (job.issue !== null && deps.hasBootstrapForIssue(job.repoDir, job.issue)) {
        enterWork(job);
        return;
      }
      deps.audit(job.repoDir, 'start', job.stepId);
      run(job);
    },
    resolve(repoDir, stepId, wipe) {
      const key = pendingKey(repoDir, stepId);
      const conflict = pending.get(key);
      if (!conflict) return;
      pending.delete(key);
      if (!deps.isCurrentStep(repoDir, stepId)) {
        deps.audit(repoDir, 'stale', stepId);
        return;
      }
      if (wipe) {
        deps.audit(repoDir, 'wipe', stepId, conflict.target.branch);
        run(conflict.job, conflict.target);
        return;
      }
      deps.audit(repoDir, 'decline', stepId, conflict.target.branch);
      if (!deps.rollbackStep(repoDir, stepId)) {
        deps.audit(repoDir, 'stale', stepId);
        return;
      }
      deps.audit(repoDir, 'rollback', stepId, 'operator declined branch wipe');
    },
  };
}
