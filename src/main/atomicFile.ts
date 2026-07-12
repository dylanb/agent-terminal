// Shared hardened atomic write for app-owned state (§19.1/§25): the one primitive the monitor-event
// store, the todo store, the UI-settings store, and the flow-state store all persist through, so the
// symlink/exclusive-create hardening lives in one place instead of being re-derived per store
// (CLAUDE.md shared-semantics rule). The app NEVER modifies the user's .gitignore — this writes only
// the file it is given (no-gitignore-writes rule).

import { lstatSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { isErrno } from './errno';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

/** True only when `dir` is a real directory or does not exist yet (mkdir will create a real one). A symlink
 *  — even to a directory — is rejected: the kernel would follow it, landing the write (state that may carry
 *  secrets) wherever the link points (CWE-59). Callers that MEAN to follow a link the user placed themselves
 *  resolve the destination first and pass the real path — see `resolveOwnedDirJail` and §18.1; what this
 *  refuses is a link the caller did not intend to traverse. A concurrent process racing the check to swap
 *  the directory after it passes is a TOCTOU residual (CWE-367) that a path-string lstat cannot close
 *  without dir-fd O_NOFOLLOW APIs Node does not expose; `wx` still blocks clobbering an existing file. */
export function isRealContainer(dir: string): boolean {
  try {
    return lstatSync(dir).isDirectory();
  } catch (e) {
    // ONLY absence is "mkdir will make a real one". Any other failure (EACCES on a parent, ENOTDIR) leaves
    // us unable to say the container is real, and a write must not proceed on a container we could not see.
    return isErrno(e, 'ENOENT');
  }
}

export interface AtomicWriteOptions {
  /** Mode for the created file; defaults to owner-only (0o600) — app-owned state may carry secrets. */
  mode?: number;
  /** Test seam for the otherwise-unpredictable temp path; defaults to an unpredictable per-write name
   *  so a cloned repo cannot pre-plant a symlink at it for the write to follow (CWE-59). */
  tmpPath?: (file: string) => string;
}

/** Atomically write `data` to `file` via an unpredictable temp + exclusive create + rename. Refuses (returns
 *  false, writes nothing) when the container directory is a symlink, so the write cannot be redirected
 *  through one the caller did not intend to follow (CWE-59); returns true on success. mkdir's the container.
 *  The exclusive-create `wx` throws if the temp path is a pre-planted symlink rather than following it —
 *  that throw propagates (callers treat persistence as best-effort at their own seam). */
export function atomicWriteFileSync(file: string, data: string | Uint8Array, opts: AtomicWriteOptions = {}): boolean {
  const dir = path.dirname(file);
  if (!isRealContainer(dir)) return false;
  mkdirSync(dir, { recursive: true });
  const tmp = (opts.tmpPath ?? ((f: string): string => `${f}.${randomUUID()}.tmp`))(file);
  try {
    writeFileSync(tmp, data, { mode: opts.mode ?? 0o600, flag: 'wx' });
  } catch (e) {
    // EEXIST means the temp pre-existed (a planted symlink/file we did not create) — never unlink it.
    // Otherwise the exclusive create succeeded but the write failed, orphaning our temp; the
    // unpredictable name would leak one stale file per failed write (CWE-459).
    if (!isErrno(e, 'EEXIST')) tryUnlink(tmp);
    throw e;
  }
  try {
    renameSync(tmp, file);
  } catch (e) {
    tryUnlink(tmp);
    throw e;
  }
  return true;
}

function tryUnlink(p: string): void {
  try {
    unlinkSync(p);
  } catch {}
}
