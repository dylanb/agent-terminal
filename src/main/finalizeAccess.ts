import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { reconstructTimeline, type RunTimeline } from '../shared/audit';
import { auditRootDir } from './auditPaths';
import { readCurrentAuditRun } from './auditRun';
import { confinedRealPath, resolveJail } from './confinedPath';
import { createGitHubPullRequestBodies } from './pullRequestBody';
import { publishFlowAudit } from './flowAuditPublication';
import { resolveAppHome } from './launchRoot';

export function readCurrentAudit(repoDir: string): RunTimeline {
  try {
    return readCurrentAuditRun(auditRootDir(resolveAppHome(process.env, homedir())), realpathSync(repoDir));
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
    await publishFlowAudit(createGitHubPullRequestBodies(repo), pr, readFileSync(file, 'utf8'));
    return { outcome: 'done' };
  }
  throw new Error('expected audit-evidence <repo> or publish-flow-audit <repo> <PR> <artifact>');
}
