// A2 (#133) §18.7.4 AC11 — the cross-process advisory worktree lock that serializes flow:start with the
// active-flow pointer write, so a second app instance cannot persist in_progress between the write gate's
// started-ness read and the pointer write (CWE-367). The lockfile lives on the user's app-owned ground, keyed by
// the resolved worktree path, never in the worktree itself, where a hosted agent could plant one to wedge the
// gate. Acquisition is fail-fast and fail-closed; only stale-lock reclaim is best-effort.

import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { linkSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isRealContainer } from './atomicFile';
import { confinedRealPath, resolveOwnedDirJail } from './confinedPath';
import { errMsg, isErrno } from './errno';
import { flowHomeDir } from './flow';

/** The lock holder's identity: a PID plus that process's start-time, which a FOREIGN acquirer can independently
 *  re-derive from OS state — so a recycled or planted live PID cannot pass as the holder. */
export interface LockHolder {
  pid: number;
  startTime: string | null;
}

export type HolderLiveness = 'dead' | 'live-matching' | 'live-mismatch' | 'unreadable';

export type LockAcquire = { ok: true; release: () => void } | { ok: false; reason: string };
export type LockedResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface WorktreeLockDeps {
  /** App-owned directory the lockfiles live in (see `worktreeLockRoot`). */
  lockRoot: string;
  holderLiveness?: (holder: LockHolder) => HolderLiveness;
  /** Runs after a lock is judged stale and before it is reclaimed — the point two reclaimers can interleave. */
  beforeReclaim?: () => void;
  /** Creates `file` holding `content`, failing with EEXIST when it already exists. */
  writeNewFile?: (file: string, content: string) => void;
}

export interface WorktreeLock {
  acquire(worktreeDir: string): LockAcquire;
  /** Run `fn` holding the worktree's lock, releasing it whether `fn` returns or throws; refuses (without running
   *  `fn`) when the lock cannot be acquired. */
  withWorktreeLock<T>(worktreeDir: string, fn: () => T): LockedResult<T>;
}

/** Bounds a macOS `ps` start-time probe, which runs synchronously on the main process. */
export const PROCESS_START_TIME_TIMEOUT_MS = 2_000;

/** Bounds the acquire ↔ reclaim retry by attempt count, never by elapsed time. */
const MAX_ACQUIRE_ATTEMPTS = 4;

const HELD_REASON =
  "Another Agent Terminal window is changing this worktree's flow right now; try again in a moment.";

/** The lockfiles' directory under the app-state home — the one location every app instance derives. */
export function worktreeLockRoot(appHome: string): string {
  return path.join(flowHomeDir(appHome), 'locks');
}

function worktreeIdentity(worktreeDir: string): string {
  try {
    return realpathSync(worktreeDir);
  } catch {
    return path.resolve(worktreeDir);
  }
}

export function worktreeLockFile(lockRoot: string, worktreeDir: string): string {
  const key = createHash('sha256').update(worktreeIdentity(worktreeDir)).digest('hex');
  return path.join(lockRoot, `worktree-${key}.lock`);
}

export function serializeLockHolder(holder: LockHolder): string {
  return JSON.stringify({ pid: holder.pid, start_time: holder.startTime });
}

function parseLockHolder(text: string): LockHolder | null {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof doc !== 'object' || doc === null) return null;
  const { pid, start_time: startTime } = doc as { pid?: unknown; start_time?: unknown };
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return null;
  if (startTime !== null && typeof startTime !== 'string') return null;
  return { pid, startTime };
}

/** A process's start-time in one canonical, locale/TZ-independent form, or null when it cannot be read.
 *  Linux: /proc/<pid>/stat field 22 (proc(5)). macOS: `ps -o lstart=` under LC_ALL=C TZ=UTC. */
export function processStartTime(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
      return fields[19] ?? null;
    }
    if (process.platform === 'darwin') {
      const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf8',
        env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: PROCESS_START_TIME_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      }).trim();
      return out.length > 0 ? out : null;
    }
  } catch {
    return null;
  }
  return null;
}

let selfStartTime: string | null | undefined;

export function currentLockHolder(): LockHolder {
  if (selfStartTime === undefined) selfStartTime = processStartTime(process.pid);
  return { pid: process.pid, startTime: selfStartTime };
}

export function realHolderLiveness(holder: LockHolder): HolderLiveness {
  try {
    process.kill(holder.pid, 0);
  } catch (e) {
    if (isErrno(e, 'ESRCH')) return 'dead';
    if (!isErrno(e, 'EPERM')) return 'unreadable';
  }
  if (holder.startTime === null) return 'unreadable';
  const actual = processStartTime(holder.pid);
  if (actual === null) return 'unreadable';
  return actual === holder.startTime ? 'live-matching' : 'live-mismatch';
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch (e) {
    if (isErrno(e, 'ENOENT')) return null;
    throw e;
  }
}

function tryUnlink(file: string): void {
  try {
    unlinkSync(file);
  } catch {}
}

function writeNewPrivateFile(file: string, content: string): void {
  writeFileSync(file, content, { mode: 0o600, flag: 'wx' });
}

/** Exclusive create with its content already in place: the holder is written to a private temp and hard-linked
 *  into place, which fails with EEXIST when the lock exists — so no peer ever reads a half-written holder. */
function tryCreate(file: string, content: string, writeNewFile: (file: string, content: string) => void): boolean {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    writeNewFile(tmp, content);
    linkSync(tmp, file);
    return true;
  } catch (e) {
    if (isErrno(e, 'EEXIST')) return false;
    throw e;
  } finally {
    tryUnlink(tmp);
  }
}

export function createWorktreeLock(deps: WorktreeLockDeps): WorktreeLock {
  const liveness = deps.holderLiveness ?? realHolderLiveness;
  const writeNewFile = deps.writeNewFile ?? writeNewPrivateFile;

  const isStale = (text: string): boolean | 'unknown' => {
    const holder = parseLockHolder(text);
    if (holder === null) return true;
    const live = liveness(holder);
    if (live === 'dead' || live === 'live-mismatch') return true;
    return live === 'unreadable' ? 'unknown' : false;
  };

  /** Remove `file` only while it still holds the stale content observed, under a reclaim guard that is itself an
   *  exclusive create — so of two reclaimers that judged the same lock stale, the later one re-inspects the
   *  winner's live lock instead of deleting it. */
  const reclaim = (file: string, staleText: string, self: string): void => {
    const guard = `${file}.reclaim`;
    if (!tryCreate(guard, self, writeNewFile)) {
      const guardText = readText(guard);
      if (guardText !== null && isStale(guardText) === true) tryUnlink(guard);
      return;
    }
    try {
      if (readText(file) === staleText) unlinkSync(file);
    } finally {
      tryUnlink(guard);
    }
  };

  const acquire = (worktreeDir: string): LockAcquire => {
    const refuse = (detail?: string): LockAcquire => ({
      ok: false,
      reason: detail === undefined ? HELD_REASON : `The worktree lock could not be taken: ${detail}`,
    });
    const jail = resolveOwnedDirJail(deps.lockRoot);
    const file = jail === null ? null : confinedRealPath(jail, worktreeLockFile(deps.lockRoot, worktreeDir));
    if (file === null) return refuse('the lock directory is unresolvable');
    const self = serializeLockHolder(currentLockHolder());
    try {
      if (!isRealContainer(path.dirname(file))) return refuse('the lock directory is not a real directory');
      mkdirSync(path.dirname(file), { recursive: true });
      for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
        if (tryCreate(file, self, writeNewFile)) {
          return {
            ok: true,
            release: () => {
              try {
                if (readText(file) === self) unlinkSync(file);
              } catch {}
            },
          };
        }
        const text = readText(file);
        if (text === null) continue;
        if (isStale(text) !== true) return refuse();
        deps.beforeReclaim?.();
        reclaim(file, text, self);
      }
    } catch (e) {
      return refuse(errMsg(e));
    }
    return refuse();
  };

  return {
    acquire,
    withWorktreeLock(worktreeDir, fn) {
      const got = acquire(worktreeDir);
      if (!got.ok) return got;
      try {
        return { ok: true, value: fn() };
      } finally {
        got.release();
      }
    },
  };
}
