// Shared hardened atomic write for app-owned state (§19.1/§25): every app-owned persistence routes through
// this one primitive, so the symlink/exclusive-create hardening lives in one place instead of being
// re-derived per store (CLAUDE.md shared-semantics rule). The app NEVER modifies the user's .gitignore —
// this writes only the file it is given (no-gitignore-writes rule).

import { accessSync, constants, lstatSync, mkdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { isErrno } from './errno';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

/** False ONLY for a non-directory confirmed in place — a symlink (even to a directory) or a plain file —
 *  which the kernel would follow, landing the write (state that may carry secrets) wherever it points
 *  (CWE-59). A symlink always lstats successfully, so a lstat that THROWS is never one: the write is let
 *  through and its own error (EACCES, ENOTDIR) surfaces downstream, rather than being reported here as a
 *  symlink that isn't there and silently dropped. Callers that MEAN to follow a link the user placed
 *  themselves resolve the destination first and pass the real path — see `resolveOwnedDirJail` and §18.1.
 *  A concurrent process racing the check to swap the directory after it passes is a TOCTOU residual
 *  (CWE-367) a path-string lstat cannot close without dir-fd O_NOFOLLOW APIs Node does not expose; `wx`
 *  still blocks clobbering an existing file. */
export function isRealContainer(dir: string): boolean {
  try {
    return lstatSync(dir).isDirectory();
  } catch {
    return true;
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

/** CWE-59/CWE-732: false for a symlinked container (isRealContainer) and for one the process cannot write —
 *  a read-only or root-owned tier root on a managed machine (0o555). Walks up past not-yet-created ancestors
 *  (ENOENT) to the first that answers W_OK, so a to-be-created destination is writable iff a real ancestor
 *  is. One definition, shared by the previewed install action and AC 5's migration writer, which write into
 *  the same container (CLAUDE.md shared-semantics). */
export function isWritableContainer(dir: string): boolean {
  if (!isRealContainer(dir)) return false;
  let probe = dir;
  for (;;) {
    try {
      accessSync(probe, constants.W_OK);
      return true;
    } catch (e) {
      if (!isErrno(e, 'ENOENT')) return false;
      const parent = path.dirname(probe);
      if (parent === probe) return false;
      probe = parent;
    }
  }
}

/** A member of a tree written by `atomicWriteTreeSync`: `relPath` is relative to the destination directory
 *  (forward-only, POSIX-style). */
export interface AtomicWriteTreeMember {
  relPath: string;
  data: string | Uint8Array;
}

export interface AtomicWriteTreeOptions {
  /** Mode for created files; defaults to owner-only (0o600). */
  mode?: number;
  /** Test seam for the otherwise-unpredictable staging directory; defaults to an unpredictable sibling of
   *  destDir so a cloned repo cannot pre-plant a symlink at it for the write to follow (CWE-59). */
  stageDir?: (destDir: string) => string;
}

/** Four outcomes classified by what the DESTINATION is (lstat), never by the commit's errno, so a planted
 *  symlink (a CWE-59 signal) is never folded into the benign already-answered case — the distinguish-refusals
 *  contract `ConfinedPath` states. Anything the destination does not explain throws. */
export type AtomicWriteTreeResult =
  | { ok: true }
  | { ok: false; cause: 'destination-exists' }
  | { ok: false; cause: 'container-refused' };

/** Atomically write a whole directory tree to `destDir`: stage every member into an unpredictable sibling
 *  (each via the module's per-file hardened write) and commit with ONE `renameSync`, so no partial tree can
 *  exist for a reader to find (AC 5). All-or-nothing is structural — `rename(2)` refuses a non-empty or
 *  non-directory destination — so there is no probe and no TOCTOU window. It refuses a non-writable resolved
 *  container before staging (`container-refused`, no write attempted); on a commit failure it classifies the
 *  destination (`destination-exists` for a real directory, `container-refused` for any non-directory) and
 *  throws when the destination does not explain it. A failure during staging removes only the entries THIS
 *  call created (directory-capable, bottom-up, never throwing into the caller, never a member whose exclusive
 *  create was refused — that CWE-59 signal is left in place) and rethrows. */
export function atomicWriteTreeSync(
  destDir: string,
  members: readonly AtomicWriteTreeMember[],
  opts: AtomicWriteTreeOptions = {},
): AtomicWriteTreeResult {
  const container = path.dirname(destDir);
  if (!isWritableContainer(container)) return { ok: false, cause: 'container-refused' };
  const mkStage = opts.stageDir ?? ((d: string): string => path.join(path.dirname(d), `.${path.basename(d)}.${randomUUID()}.tmp`));
  const stage = mkStage(destDir);
  const mode = opts.mode ?? 0o600;
  const created: string[] = []; // creation order (parents before children); removed in reverse (bottom-up)
  try {
    mkdirSync(stage, { recursive: true });
    created.push(stage);
    const dirs = new Set<string>();
    for (const m of members) {
      let d = path.dirname(m.relPath);
      while (d && d !== '.') {
        dirs.add(d);
        d = path.dirname(d);
      }
    }
    for (const rel of [...dirs].sort((a, b) => a.split('/').length - b.split('/').length)) {
      const abs = path.join(stage, rel);
      mkdirSync(abs);
      created.push(abs);
    }
    for (const m of members) {
      const abs = path.join(stage, m.relPath);
      // Exclusive create: a pre-planted member throws EEXIST and is never overwritten or unlinked (CWE-59).
      writeFileSync(abs, m.data, { mode, flag: 'wx' });
      created.push(abs);
    }
  } catch (e) {
    // EEXIST means a member pre-existed (a planted symlink/file we did not create) — leave the staging tree
    // in place for inspection (atomicWriteFileSync's own rule); any other failure removes what we created so
    // no partial staging tree leaks (CWE-459).
    if (!isErrno(e, 'EEXIST')) removeCreated(created);
    throw e;
  }
  try {
    renameSync(stage, destDir);
  } catch (e) {
    let cause: 'destination-exists' | 'container-refused' | null;
    try {
      cause = lstatSync(destDir).isDirectory() ? 'destination-exists' : 'container-refused';
    } catch {
      cause = null; // the destination does not explain the failure
    }
    removeCreated(created);
    if (cause === null) throw e;
    return { ok: false, cause };
  }
  return { ok: true };
}

/** Remove exactly the entries a staging call created, bottom-up (children before parents) and
 *  directory-capable (`rmdirSync` for directories, `unlinkSync` for files — a bare `tryUnlink` no-ops on the
 *  def's `charter/` and `prompts/` subdirectories and leaks the tree). Each removal is wrapped so it cannot
 *  throw into the caller, and a directory left non-empty by a planted entry simply survives. */
function removeCreated(created: readonly string[]): void {
  for (let i = created.length - 1; i >= 0; i--) {
    const p = created[i];
    try {
      if (lstatSync(p).isDirectory()) rmdirSync(p);
      else unlinkSync(p);
    } catch {}
  }
}
