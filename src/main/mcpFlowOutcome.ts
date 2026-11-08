import type { FlowStateView } from '../shared/ipc';
import type { WindowAnswerFailure } from '../shared/mcpBridge';
import type { LifecycleTerminateResult } from './flowLifecycle';

export interface EntryStatus { kind: string; message: string }

const notTaken = (reason: string): WindowAnswerFailure => ({ outcome: 'neither', kind: 'not-taken', message: `Not taken: ${reason}` });

export function startedAnswer(view: FlowStateView, entry: EntryStatus | null): EntryStatus | WindowAnswerFailure {
  if (view.status !== 'in_progress') return notTaken(view.notice ?? view.error ?? 'The run could not be started. Read the state again.');
  return entry ?? { kind: 'taken', message: `Started.${view.notice ? ` ${view.notice}` : ''}` };
}

export function terminatedAnswer(result: LifecycleTerminateResult): EntryStatus | WindowAnswerFailure {
  switch (result.outcome) {
    case 'reset':
      return result.cleanupFailures?.length
        ? { outcome: 'neither', kind: 'terminated-cleanup-failed', message: `Terminated the run, but cleanup failed: ${result.cleanupFailures.join('; ')}. Resolve the reported error, then inspect and clear any remaining todos or captures in the window before starting another run.` }
        : { kind: 'taken', message: 'Terminated the run, cleared captures and deleted its todos.' };
    case 'refused': return notTaken(result.cause === 'not-begun' ? 'The run has not begun. Read the state again.' : result.reason);
    default: return result satisfies never;
  }
}
