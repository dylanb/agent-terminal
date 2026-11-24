// §27.4 — owns the installation hold and pending Start/Restart recovery for each worktree.
import type { AgentKind } from '../shared/agentKind';
import type { FlowStateView } from '../shared/ipc';
import type { LifecycleTerminateResult } from './flowLifecycle';
import type { WorktreeLock } from './worktreeLock';
import { errMsg } from './errno';
import { installsPerRun } from './reviewerPlacement';
import { REVIEWERS_REMOVED_NOTICE, type EnsureRunReviewersResult } from './runReviewers';

type RetryAction = 'start' | 'restart';
interface RecoveryDeps {
  install(repoKey: string): EnsureRunReviewersResult;
  remove(repoKey: string): string[];
  lock: Pick<WorktreeLock, 'withWorktreeLock'>;
  currentView(repoKey: string, notice?: string): FlowStateView;
  terminate(repoKey: string): LifecycleTerminateResult;
}

export function createReviewerInstallationRecovery(deps: RecoveryDeps) {
  const failures = new Map<string, { reason: string; retry?: RetryAction }>();
  return {
    prepare(repoKey: string, running: AgentKind | null, retry?: RetryAction): EnsureRunReviewersResult {
      if (!installsPerRun(running)) return { wrote: [], problems: [] };
      let result: EnsureRunReviewersResult;
      try { result = deps.install(repoKey); }
      catch (error) { result = { wrote: [], problems: [errMsg(error)] }; }
      if (result.problems.length > 0) failures.set(repoKey, {
        reason: result.problems.join('\n'),
        retry: retry ?? failures.get(repoKey)?.retry,
      });
      else failures.delete(repoKey);
      return result;
    },
    hold(repoKey: string): string | null { return failures.get(repoKey)?.reason ?? null; },
    retryView(repoKey: string): Pick<FlowStateView, 'installationRetry' | 'notice'> {
      const failure = failures.get(repoKey);
      return failure?.retry ? { installationRetry: failure.retry, notice: failure.reason } : {};
    },
    terminate(repoKey: string): FlowStateView {
      const failure = failures.get(repoKey);
      if (failure?.retry) {
        const canceled = deps.lock.withWorktreeLock(repoKey, () => {
          const problems = deps.remove(repoKey);
          if (problems.length > 0) {
            failures.set(repoKey, { ...failure, reason: problems.join('\n') });
            return deps.currentView(repoKey);
          }
          failures.delete(repoKey);
          return deps.currentView(repoKey, REVIEWERS_REMOVED_NOTICE);
        });
        return canceled.ok ? canceled.value : deps.currentView(repoKey, canceled.reason);
      }
      const terminated = deps.terminate(repoKey);
      if (terminated.outcome === 'reset') failures.delete(repoKey);
      return terminated.view;
    },
  };
}
