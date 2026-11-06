// §18.7.4 AC11 (CWE-367). The lockfile lives on the user's app-owned ground, never in the worktree itself, where a
// hosted agent could plant one to wedge the gate. Only an unusable lock runs the critical section without the lock, an
// accepted residual (§18.7.4).

import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { linkSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isRealContainer } from './atomicFile';
import { confinedRealPath, resolveOwnedDirJail } from './confinedPath';
import { errMsg, isErrno } from './errno';
import { flowHomeDir } from './flow';
import { displaySafeEcho, MAX_ECHOED_PATH_LENGTH, MAX_ECHOED_REASON_LENGTH } from '../shared/controlChars';

/** The lock holder's identity: a PID plus that process's start-time, which a FOREIGN acquirer can independently
 *  re-derive from OS state — so a recycled or planted live PID cannot pass as the holder. */
export interface LockHolder {
  pid: number;
  startTime: string | null;
}

export type HolderLiveness = 'dead' | 'live-matching' | 'live-mismatch' | 'unreadable';

export type LockRefusalCause = 'held' | 'holder-unreadable' | 'lock-unusable';

/** §18.7.6 (CWE-116/400) — re-bounding a `reason` at MAX_ECHOED_REASON_LENGTH cuts off the lockfile path the user
 *  must delete. */
export type LockAcquire = { ok: true; release: () => void } | { ok: false; cause: LockRefusalCause; reason: string };
export type LockedResult<T> = { ok: true; value: T } | { ok: false; reason: string };

declare const lockScopeBrand: unique symbol;
/** Minted only by `withWorktreeLock` for its callback: proof the caller went through the lock's policy (CWE-367). */
export type WorktreeLockScope = { readonly [lockScopeBrand]: true };
const LOCK_SCOPE = Object.freeze({}) as WorktreeLockScope;

export interface WorktreeLockDeps {
  /** App-owned directory the lockfiles live in (see `worktreeLockRoot`). */
  lockRoot: string;
  holderLiveness?: (holder: LockHolder) => HolderLiveness;
  /** Runs after a lock is judged stale and before it is reclaimed — the point two reclaimers can interleave. */
  beforeReclaim?: () => void;
  /** Creates `file` holding `content`, failing with EEXIST when it already exists. */
  writeNewFile?: (file: string, content: string) => void;
  /** What a refusal tells the user; defaults to the worktree-flow wording. */
  wording?: LockRefusalWording;
}

/** A refusal's user-facing text, named for what the lock guards. */
export interface LockRefusalWording {
  /** `holder` is null when the lock changed hands too often to name one. */
  held(holder: LockHolder | null): string;
  /** `target` is the display-safe file the user must delete. */
  unidentified(target: string): string;
  unusable(detail: string): string;
}

export interface WorktreeLock {
  acquire(worktreeDir: string): LockAcquire;
  /** Runs `fn` without the lock only when the cause is `lock-unusable`. A call nested inside another's `fn` for the
   *  same worktree on this instance runs `fn` under the lock already held. */
  withWorktreeLock<T>(worktreeDir: string, fn: (scope: WorktreeLockScope) => T): LockedResult<T>;
}

/** Bounds a macOS `ps` start-time probe, which runs synchronously on the main process. */
export const PROCESS_START_TIME_TIMEOUT_MS = 2_000;

/** Bounds the acquire ↔ reclaim retry by attempt count, never by elapsed time. */
export const MAX_ACQUIRE_ATTEMPTS = 4;

const WORKTREE_WORDING: LockRefusalWording = {
  held: () => "Another Agent Terminal window is changing this worktree's flow right now; try again in a moment.",
  unidentified: (target) =>
    "The worktree lock is held by a process that cannot be identified. If no other Agent Terminal window is working in " +
    `this worktree, delete ${target} and try again.`,
  unusable: (detail) => `The worktree lock could not be taken: ${detail}`,
};

const reclaimGuard = (file: string): string => `${file}.reclaim`;

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

export function selfLockHolder(startTimeOf: (pid: number) => string | null): () => LockHolder {
  let selfStartTime: string | null = null;
  return () => {
    selfStartTime ??= startTimeOf(process.pid);
    return { pid: process.pid, startTime: selfStartTime };
  };
}

export const currentLockHolder = selfLockHolder(processStartTime);

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
  const wording = deps.wording ?? WORKTREE_WORDING;

  const held = (holder: LockHolder | null): LockAcquire => ({ ok: false, cause: 'held', reason: wording.held(holder) });
  const unusable = (detail: string): LockAcquire => ({
    ok: false,
    cause: 'lock-unusable',
    reason: wording.unusable(displaySafeEcho(detail, MAX_ECHOED_REASON_LENGTH)),
  });
  const unidentifiedHolder = (lockFile: string): LockAcquire => {
    const shown = displaySafeEcho(lockFile, MAX_ECHOED_PATH_LENGTH);
    const target = shown === lockFile ? lockFile : `the file ${path.basename(lockFile)} in Agent Terminal's lock directory`;
    return { ok: false, cause: 'holder-unreadable', reason: wording.unidentified(target) };
  };

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
  const reclaim = (file: string, staleText: string, self: string): boolean | 'unknown' => {
    const guard = reclaimGuard(file);
    if (!tryCreate(guard, self, writeNewFile)) {
      const guardText = readText(guard);
      if (guardText === null) return true;
      const guardStale = isStale(guardText);
      if (guardStale === true) tryUnlink(guard);
      return guardStale;
    }
    try {
      if (readText(file) === staleText) unlinkSync(file);
    } finally {
      tryUnlink(guard);
    }
    return true;
  };

  /** The refusal a lock holding `text` owes its would-be acquirer, or null when that holder is stale. */
  const refusalFor = (lockFile: string, text: string): LockAcquire | null => {
    const stale = isStale(text);
    if (stale === false) return held(parseLockHolder(text));
    return stale === 'unknown' ? unidentifiedHolder(lockFile) : null;
  };

  const acquire = (worktreeDir: string): LockAcquire => {
    const heldBy = (lockFile: string): LockAcquire | null => {
      try {
        const text = readText(lockFile);
        return text === null ? null : refusalFor(lockFile, text);
      } catch {
        return null;
      }
    };
    const jail = resolveOwnedDirJail(deps.lockRoot);
    const file = jail === null ? null : confinedRealPath(jail, worktreeLockFile(deps.lockRoot, worktreeDir));
    if (file === null) return unusable('the lock directory is unresolvable');
    const self = serializeLockHolder(currentLockHolder());
    let sawLive = false;
    let sawUnreadable = false;
    try {
      if (!isRealContainer(path.dirname(file))) return unusable('the lock directory is not a real directory');
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
        if (text === null) {
          sawLive = true;
          continue;
        }
        const refusal = refusalFor(file, text);
        if (refusal !== null) return refusal;
        deps.beforeReclaim?.();
        const guard = reclaim(file, text, self);
        if (guard === false) sawLive = true;
        else if (guard === 'unknown') sawUnreadable = true;
      }
    } catch (e) {
      return heldBy(file) ?? unusable(errMsg(e));
    }
    if (sawLive) return held(null);
    if (sawUnreadable) return unidentifiedHolder(reclaimGuard(file));
    return unusable('every stale-lock reclaim was lost');
  };

  const holding = new Set<string>();
  return {
    acquire,
    withWorktreeLock(worktreeDir, fn) {
      if (holding.has(worktreeDir)) return { ok: true, value: fn(LOCK_SCOPE) };
      const got = acquire(worktreeDir);
      if (!got.ok) {
        if (got.cause === 'lock-unusable') return { ok: true, value: fn(LOCK_SCOPE) };
        return { ok: false, reason: got.reason };
      }
      holding.add(worktreeDir);
      try {
        return { ok: true, value: fn(LOCK_SCOPE) };
      } finally {
        holding.delete(worktreeDir);
        got.release();
      }
    },
  };
}
