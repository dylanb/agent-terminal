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

const ELAPSED = /^(?:(?:(\d+)-)?(\d{1,2}):)?(\d{1,2}):(\d{2})$/;

/** `ps -o etime` prints `[[dd-]hh:]mm:ss`. */
export function parseElapsed(text: string): number | null {
  const m = ELAPSED.exec(text.trim());
  if (m === null) return null;
  const [days, hours, minutes, seconds] = [m[1], m[2], m[3], m[4]].map((v) => Number(v ?? 0));
  return ((days * 24 + hours) * 60 + minutes) * 60 + seconds;
}

/** `etime` drops the fraction of a second, so a second more is taken off: the start is never placed after the
 *  process really began, which makes a reviewer file written in the same second count as newer. */
export function processStartedAt(pid: number, now: () => number = Date.now): number | null {
  const asked = now();
  try {
    const elapsed = parseElapsed(ps('etime', pid));
    return elapsed === null ? null : asked - (elapsed + 1) * 1000;
  } catch {
    return null;
  }
}

export function foregroundStartedAt(shellPid: number): number | null {
  try {
    const group = Number(ps('tpgid', shellPid));
    return Number.isInteger(group) && group > 0 ? processStartedAt(group) : null;
  } catch {
    return null;
  }
}
