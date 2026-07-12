// The one path-confinement primitive for the main process (CLAUDE.md — never hand-rolled). It is not in
// `src/shared/` because it needs `node:fs`, and `src/shared/` must stay importable by the renderer.

import { realpathSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { isErrno } from './errno';

function isAbsent(p: string): boolean {
  try {
    lstatSync(p);
    return false;
  } catch (e) {
    return isErrno(e, 'ENOENT');
  }
}

/** The symlink-free real path of `p`: symlinks in its longest existing prefix are resolved and a tail of
 *  not-yet-created segments is appended. Only a genuinely absent (ENOENT) segment is appended; a segment
 *  that exists but does not resolve — a dangling symlink — or one that is inaccessible or traversed as a
 *  non-directory yields null, since none can be reduced to a symlink-free path. Never throws. */
export function realpathBounded(p: string): string | null {
  const abs = path.resolve(p);
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      return path.join(realpathSync(cur), ...tail.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      if (!isAbsent(cur)) return null;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** A jail that lives INSIDE UNTRUSTED CONTENT (a checked-out repo working tree), where a link can be planted
 *  at the jail's own final segment: `anchorDir` is resolved through symlinks, `segments` are appended
 *  WITHOUT resolution, so a planted link cannot adopt its target as the jail. Null when `anchorDir` does not
 *  resolve. CWE-59. For a root in the user's own space that the app derives, use `resolveOwnedDirJail`. */
export function resolveJail(anchorDir: string, ...segments: string[]): string | null {
  try {
    return path.join(realpathSync(anchorDir), ...segments);
  } catch {
    return null;
  }
}

/** A jail in the USER'S OWN SPACE that the app derives itself (`$HOME`, `CLAUDE_CONFIG_DIR`, …) and which
 *  may not exist yet: resolved through symlinks INCLUDING its own final segment, with any not-yet-created
 *  tail appended. Null when the path cannot be reduced to a symlink-free real path. Confinement still holds
 *  inside the returned jail — see `confinedRealPathResult` (CWE-22/59). Following a link the user placed at
 *  their own config dir is the policy of §18.1, not of this function. */
export function resolveOwnedDirJail(dir: string): string | null {
  return realpathBounded(path.resolve(dir));
}

/** Why a path was refused. `escapes` is a link or `..` that leaves the jail (CWE-22/59); `unresolvable` is
 *  a path that cannot be reduced to a symlink-free real path at all — a dangling link, or a segment that is
 *  unreadable or is not a directory. The two call for opposite fixes, so a caller that reports a refusal to
 *  a human MUST distinguish them rather than blaming a link for a permission problem. */
export type PathRefusal = 'escapes' | 'unresolvable';
export type ConfinedPath = { ok: true; path: string } | { ok: false; cause: PathRefusal };

/** `target`'s symlink-free real path when it stays inside `jail`, else the reason it was refused. `jail`
 *  must already be resolved (see `resolveJail`); callers use the returned path directly, not the original.
 *  Existence of `target` is the caller's concern. CWE-22, CWE-59, CWE-367. */
export function confinedRealPathResult(jail: string, target: string): ConfinedPath {
  const real = realpathBounded(path.resolve(target));
  if (real === null) return { ok: false, cause: 'unresolvable' };
  const prefix = jail.endsWith(path.sep) ? jail : jail + path.sep;
  return real === jail || real.startsWith(prefix) ? { ok: true, path: real } : { ok: false, cause: 'escapes' };
}

/** The same confinement for callers that only gate on it and never report the cause to a human. */
export function confinedRealPath(jail: string, target: string): string | null {
  const r = confinedRealPathResult(jail, target);
  return r.ok ? r.path : null;
}
