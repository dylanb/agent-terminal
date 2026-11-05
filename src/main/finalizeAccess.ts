import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { auditTimestamp, reconstructTimeline, type RunTimeline } from '../shared/audit';
import { auditFilePath, auditRootDir } from './auditPaths';
import { createFlowStateStore } from './flowState';
import { MAX_LOOP_ARTIFACT_BYTES } from './appLoopPaths';
import { readBoundedNoFollow } from './boundedRead';
import { errMsg } from './errno';
import { confinedRealPath, resolveJail, resolveOwnedDirJail } from './confinedPath';
import { createGitHubPullRequestBodies } from './pullRequestBody';
import { publishFlowAudit } from './flowAuditPublication';
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

function auditArtifactText(file: string): string {
  const read = readBoundedNoFollow(file, MAX_LOOP_ARTIFACT_BYTES);
  if (read.ok) return read.text;
  switch (read.cause) {
    case 'absent':
      throw new Error('audit artifact does not exist');
    case 'over-cap':
      throw new Error(`audit artifact is larger than ${MAX_LOOP_ARTIFACT_BYTES} bytes`);
    case 'unreadable':
      throw new Error(read.error === undefined ? 'audit artifact is unreadable: not a regular file' : errMsg(read.error));
    default:
      return read.cause satisfies never;
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
    await publishFlowAudit(createGitHubPullRequestBodies(repo), pr, auditArtifactText(file));
    return { outcome: 'done' };
  }
  throw new Error('expected audit-evidence <repo> or publish-flow-audit <repo> <PR> <artifact>');
}
