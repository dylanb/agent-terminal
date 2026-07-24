import type { AppLoopEntry } from './appLoopEngine';
import type { AppLoopBootstrap } from './appLoopState';
import type { BootstrapGit, BootstrapGitHub } from './bootstrapPorts';
import { errMsg } from './errno';
import type { AppBootstrapAuditKind } from '../shared/audit';

export interface AppLoopBootstrapDeps {
  git: BootstrapGit;
  github: BootstrapGitHub;
  rollbackCreatedBranch(branch: string): Promise<void>;
  writeBootstrap(identity: AppLoopBootstrap): void;
}

export interface AppLoopBootstrapRequest {
  issue: number;
  spec: AppLoopBootstrapSpec;
}

export interface AppLoopBootstrapSpec {
  origin: 'operator' | 'app-bundled' | 'repo';
  branchTemplate: string;
  initialLabels: Array<{
    action: 'add' | 'remove';
    target: 'issue' | 'pr';
    label: string;
  }>;
}

export type AppLoopBootstrapResult =
  | { ok: true; identity: AppLoopBootstrap }
  | { ok: false; error: string };

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
  const fail = (error: string): AppLoopBootstrapResult => ({ ok: false, error });
  if (req.spec.origin !== 'operator') {
    return fail(`refused bootstrap from a non-operator-authored loop def (origin: ${req.spec.origin})`);
  }
  if (!Number.isSafeInteger(req.issue) || req.issue <= 0) return fail('pickup requires a positive GitHub issue number');
  let createdBranch: string | null = null;
  try {
    if (!(await deps.git.isCleanTree())) return fail('working tree is not clean');
    const base = await deps.git.resolveBaseBranch();
    if (!base) return fail('could not resolve base branch');
    const branch = req.spec.branchTemplate.replaceAll('{issue}', String(req.issue));
    if (!SAFE_BRANCH.test(branch)) return fail(`unsafe branch name from branch_template: ${branch}`);
    if (await deps.git.branchExists(branch)) {
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
    return { ok: true, identity };
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
  audit(repoDir: string, kind: AppBootstrapAuditKind, stepId: string, detail?: string): void;
}

export interface AppLoopBootstrapCoordinator {
  enter(job: AppLoopBootstrapJob): void;
}

export function createAppLoopBootstrapCoordinator(
  deps: AppLoopBootstrapCoordinatorDeps,
): AppLoopBootstrapCoordinator {
  const enterWork = (job: AppLoopBootstrapJob): void =>
    deps.enterWork(job.repoDir, job.loopName, job.stepId, job.entry);

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
      const resolve = (result: AppLoopBootstrapResult): void => {
        if (!deps.isCurrentStep(job.repoDir, job.stepId)) {
          deps.audit(job.repoDir, 'stale', job.stepId);
          return;
        }
        if (result.ok) {
          deps.audit(job.repoDir, 'success', job.stepId, result.identity.branch);
          enterWork(job);
          return;
        }
        deps.audit(job.repoDir, 'failure', job.stepId, result.error);
        if (!deps.rollbackStep(job.repoDir, job.stepId)) {
          deps.audit(job.repoDir, 'stale', job.stepId);
          return;
        }
        deps.audit(job.repoDir, 'rollback', job.stepId, result.error);
        deps.emitError({ repoDir: job.repoDir, stepId: job.stepId, reason: result.error });
      };
      const operation =
        job.issue === null
          ? Promise.resolve<AppLoopBootstrapResult>({
              ok: false,
              error: 'pickup requires a resolved GitHub ticket input',
            })
          : deps.run(job.repoDir, { issue: job.issue, spec: job.bootstrap });
      void operation.then(resolve, (e: unknown) =>
        resolve({ ok: false, error: errMsg(e) }),
      );
    },
  };
}
