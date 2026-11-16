import { readFileSync } from 'node:fs';
import { auditTimestamp, reconstructTimeline, type RunTimeline } from '../shared/audit';
import { auditFilePath } from './auditPaths';
import { confinedRealPath, resolveOwnedDirJail } from './confinedPath';
import { createFlowStateStore } from './flowState';

/** `started` keeps the milliseconds the record's file name carries; the header's second-precision `started` names
 *  no file. */
export interface AuditRunId {
  repoPath: string;
  flow: string;
  started: Date;
}

/** An unfound, unreadable or mismatched record reconstructs as `unavailable`. */
export function readAuditRun(root: string, run: AuditRunId): RunTimeline {
  try {
    const jail = resolveOwnedDirJail(root);
    const file = jail && confinedRealPath(jail, auditFilePath(root, run.repoPath, run.flow, run.started));
    if (!file) return reconstructTimeline('');
    return reconstructTimeline(readFileSync(file, 'utf8'), { repoPath: run.repoPath, flow: run.flow, started: auditTimestamp(run.started) });
  } catch {
    return reconstructTimeline('');
  }
}

/** The run `flow-state.yaml` names for the worktree, or `null` when it names none. */
function currentAuditRunId(repoPath: string): AuditRunId | null {
  const state = createFlowStateStore(repoPath).read();
  if (!state?.flow || state.startedAt === undefined) return null;
  return { repoPath, flow: state.flow, started: new Date(state.startedAt) };
}

export function readCurrentAuditRun(root: string, repoPath: string): RunTimeline {
  try {
    const run = currentAuditRunId(repoPath);
    return run === null ? reconstructTimeline('') : readAuditRun(root, run);
  } catch {
    return reconstructTimeline('');
  }
}
