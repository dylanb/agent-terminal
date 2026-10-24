import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { auditTimestamp, reconstructTimeline, type RunTimeline } from '../shared/audit';
import { auditFilePath, auditRootDir } from './auditPaths';
import { createFlowStateStore } from './flowState';
import { confinedRealPath, resolveJail, resolveOwnedDirJail } from './confinedPath';
import { createRealAppGateGitHub } from './appGateGithub';
import { resolveAppHome } from './launchRoot';

export function readCurrentAudit(repoDir: string): RunTimeline {
  try {
    const repo = realpathSync(repoDir);
    const state = createFlowStateStore(repo).read();
    if (!state?.flow || state.startedAt === undefined) return reconstructTimeline('');
    const started = new Date(state.startedAt);
    const root = auditRootDir(resolveAppHome(process.env, homedir()));
    const jail = resolveOwnedDirJail(root);
    const file = jail && confinedRealPath(jail, auditFilePath(root, repo, state.flow, started));
    if (!file) return reconstructTimeline('');
    return reconstructTimeline(readFileSync(file, 'utf8'), {
      repoPath: repo, flow: state.flow, started: auditTimestamp(started),
    });
  } catch {
    return reconstructTimeline('');
  }
}

export async function runFinalizeAccess(args: string[]): Promise<unknown> {
  const [operation, repoDir, prText, artifact] = args;
  if (operation === 'audit-evidence' && repoDir && args.length === 2) return readCurrentAudit(repoDir);
  if (operation === 'publish-flow-audit' && repoDir && artifact && args.length === 4) {
    const pr = Number(prText);
    if (!Number.isSafeInteger(pr) || pr <= 0) throw new Error('PR must be a positive integer');
    const repo = realpathSync(repoDir);
    const jail = resolveJail(repo, '.agent-terminal', 'loop', 'artifacts');
    const file = jail && confinedRealPath(jail, resolve(repo, artifact));
    if (!file) throw new Error('audit artifact is outside the flow artifacts directory or unreadable');
    return createRealAppGateGitHub(repo)('publish-flow-audit', { pr, ticket: null, bodyFile: file, bootstrap: null });
  }
  throw new Error('expected audit-evidence <repo> or publish-flow-audit <repo> <PR> <artifact>');
}
