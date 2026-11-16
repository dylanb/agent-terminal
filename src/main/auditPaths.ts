// Audit file-path derivation (§25.2). Separated from src/shared/audit because it needs node:path —
// path layout is a writer (main) concern; a reader is handed a path. The stamp/timestamp vocabulary
// it builds on stays shared so the names cannot drift.

import path from 'node:path';
import { auditFileStamp } from '../shared/audit';

export function auditRootDir(home: string): string {
  return path.join(home, '.agent-terminal', 'audit');
}

/** A single filesystem segment with no separators or `..` runs, so an untrusted flow.yaml `name:` or
 *  odd repo basename cannot traverse the audit tree (CWE-22). */
function safeSegment(s: string): string {
  const cleaned = s.replace(/[^A-Za-z0-9._-]/g, '-').replace(/\.{2,}/g, '.');
  return cleaned.length > 0 ? cleaned : '-';
}

export function auditRepoDir(root: string, repoPath: string): string {
  return path.join(root, safeSegment(path.basename(repoPath)));
}

export function auditFileName(flow: string, started: Date): string {
  return `${safeSegment(flow)}_${auditFileStamp(started)}.yaml`;
}

export function auditFilePath(root: string, repoPath: string, flow: string, started: Date): string {
  return path.join(auditRepoDir(root, repoPath), auditFileName(flow, started));
}

const FILE_STAMP = /_(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2}\.\d{3})Z\.yaml$/;

export function auditFileStartedAt(name: string): Date | null {
  const m = FILE_STAMP.exec(name);
  if (m === null || m.index === 0) return null;
  const started = new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`);
  return Number.isNaN(started.getTime()) ? null : started;
}
