import { accessSync, constants, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { isErrno, errMsg } from './errno';
import { confinedRealPathResult } from './confinedPath';
import { shellQuote } from '../shared/shellQuote';

export type RepairAccess = 'read' | 'read-write' | 'enter-folder' | 'change-folder';

/** Where a repair may point: anywhere, or only inside a jail (`null` when the jail itself cannot be resolved). */
export type RepairScope = { kind: 'anywhere' } | { kind: 'within'; jail: string | null };

export const ANYWHERE: RepairScope = { kind: 'anywhere' };
export const within = (jail: string | null): RepairScope => ({ kind: 'within', jail });

const CHMOD_MODE: Record<RepairAccess, string> = {
  read: 'u+r',
  'read-write': 'u+rw',
  'enter-folder': 'u+rx',
  'change-folder': 'u+rwx',
};

const effectiveUser = (): number | undefined => process.geteuid?.() ?? process.getuid?.();

export function repairAdvice(error: unknown, target: string, access: RepairAccess, scope: RepairScope = ANYWHERE, operator = effectiveUser()): string {
  if (isErrno(error, 'ENOSPC')) return 'Free disk space, then Retry.';
  const manual = `Correct the reference or link for ${target} within its allowed source directory, then Retry.`;
  const repairPath = (file: string): string | null => {
    if (scope.kind === 'anywhere') return file;
    if (scope.jail === null) return null;
    const confined = confinedRealPathResult(scope.jail, file);
    return confined.ok ? confined.path : null;
  };
  if (isErrno(error, 'EACCES') || isErrno(error, 'EPERM')) {
    const ancestors: string[] = [];
    for (let dir = path.dirname(target); ; dir = path.dirname(dir)) {
      ancestors.unshift(dir);
      if (path.dirname(dir) === dir) break;
    }
    for (const dir of ancestors) {
      const resolved = repairPath(dir);
      if (resolved === null) continue;
      try { accessSync(resolved, constants.X_OK); } catch (e) {
        if (isErrno(e, 'EACCES') || isErrno(e, 'EPERM')) return permissionAdvice(resolved, 'u+x', operator);
        break;
      }
    }
    let existing = target;
    for (;;) {
      const resolved = repairPath(existing);
      if (resolved === null) return manual;
      if (existsSync(resolved)) return permissionAdvice(resolved, existing === target ? CHMOD_MODE[access] : CHMOD_MODE['change-folder'], operator);
      if (path.dirname(existing) === existing) return manual;
      existing = path.dirname(existing);
    }
  }
  return `Correct or restore ${target}, then Retry.`;
}

function permissionAdvice(target: string, mode: string, operator: number | undefined): string {
  let owner: number;
  try {
    owner = statSync(target).uid;
  } catch (error) {
    return `Cannot inspect ownership of ${target}: ${errMsg(error)}. Restore access to that path, then Retry.`;
  }
  if (operator === undefined || operator === 0 || owner !== operator) {
    return `Ask the owner or an administrator to inspect ${target} and restore the access needed by user ${operator ?? 'running the app'}, preserving its ownership and unrelated users' access. Verify the current path and any shared directory before making changes; do not elevate a command copied from this notice. Then Retry.`;
  }
  return `As user ${operator}, the owner of ${target}, run from any directory without sudo or a root shell:\n\`\`\`sh\nchmod ${mode} ${shellQuote(target)}\n\`\`\`\nThen Retry.`;
}
