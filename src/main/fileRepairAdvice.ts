import { accessSync, constants, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { isErrno, errMsg } from './errno';
import { confinedRealPathResult } from './confinedPath';
import { shellQuote } from '../shared/shellQuote';

export function repairAdvice(error: unknown, target: string, mode: string, jail?: string | null): string {
  if (isErrno(error, 'ENOSPC')) return 'Free disk space, then Retry.';
  const manual = `Correct the reference or link for ${target} within its allowed source directory, then Retry.`;
  const repairPath = (file: string): string | null => {
    if (jail === undefined) return file;
    if (jail === null) return null;
    const confined = confinedRealPathResult(jail, file);
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
        if (isErrno(e, 'EACCES') || isErrno(e, 'EPERM')) return permissionAdvice(resolved, 'u+x');
        break;
      }
    }
    let existing = target;
    for (;;) {
      const resolved = repairPath(existing);
      if (resolved === null) return manual;
      if (existsSync(resolved)) return permissionAdvice(resolved, existing === target ? mode : 'u+rwx');
      if (path.dirname(existing) === existing) return manual;
      existing = path.dirname(existing);
    }
  }
  return `Correct or restore ${target}, then Retry.`;
}

function permissionAdvice(target: string, mode: string): string {
  let owner: number;
  try {
    owner = statSync(target).uid;
  } catch (error) {
    return `Cannot inspect ownership of ${target}: ${errMsg(error)}. Restore access to that path, then Retry.`;
  }
  const operator = process.geteuid?.() ?? process.getuid?.();
  const quoted = shellQuote(target);
  if (operator !== undefined && owner !== operator) {
    return `Have an administrator run this block as root (for example in sudo -s), from any directory, to give user ${operator} access to ${target}:\n\`\`\`sh\nchown ${operator} ${quoted}\nchmod ${mode} ${quoted}\n\`\`\`\nThen Retry.`;
  }
  return `As the owner of ${target}, run from any directory:\n\`\`\`sh\nchmod ${mode} ${quoted}\n\`\`\`\nThen Retry.`;
}
