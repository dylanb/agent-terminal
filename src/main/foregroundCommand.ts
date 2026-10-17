// §27.4

import { execFileSync } from 'node:child_process';

const PS_TIMEOUT_MS = 1000;

function ps(field: string, pid: number): string {
  return execFileSync('ps', ['-o', `${field}=`, '-p', String(pid)], { encoding: 'utf8', timeout: PS_TIMEOUT_MS }).trim();
}

/** The full command line of the process group in the foreground of the terminal whose shell is `shellPid`,
 *  or null when the process table cannot say. */
export function foregroundCommand(shellPid: number): string | null {
  try {
    const group = Number(ps('tpgid', shellPid));
    if (!Number.isInteger(group) || group <= 0) return null;
    const args = ps('args', group);
    return args.length > 0 ? args : null;
  } catch {
    return null;
  }
}
