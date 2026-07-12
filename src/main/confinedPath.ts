// The one path-confinement primitive for the main process (CLAUDE.md — never hand-rolled). It is not in
// `src/shared/` because it needs `node:fs`, and `src/shared/` must stay importable by the renderer.

import { realpathSync, lstatSync } from 'node:fs';
import path from 'node:path';

function isAbsent(p: string): boolean {
  try {
    lstatSync(p);
    return false;
  } catch (e) {
    return e instanceof Error && 'code' in e && e.code === 'ENOENT';
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

/** A confinement directory: `anchorDir` resolved through symlinks; `segments` are appended without
 *  symlink resolution. Null when `anchorDir` does not resolve. CWE-59. */
export function resolveJail(anchorDir: string, ...segments: string[]): string | null {
  try {
    return path.join(realpathSync(anchorDir), ...segments);
  } catch {
    return null;
  }
}

/** A confinement jail for a not-yet-existing directory WHOSE PATH IS NAMED BY UNTRUSTED CONTENT: its parent
 *  chain resolved through symlinks in the longest existing prefix (realpathBounded), with the directory's
 *  own final segment appended UNRESOLVED — so a symlink planted AT the destination cannot adopt its target
 *  as the jail (resolveJail's guarantee, extended to a not-yet-created anchor). Null when the parent chain
 *  cannot be reduced to a symlink-free path. CWE-59.
 *
 *  When the app DERIVES the root itself rather than reading it out of content, use `resolveOwnedDirJail`:
 *  refusing a link the user put at their own config dir protects nothing and strands them. */
export function resolveNewDirJail(dir: string): string | null {
  const abs = path.resolve(dir);
  const parent = realpathBounded(path.dirname(abs));
  return parent === null ? null : path.join(parent, path.basename(abs));
}

/** A confinement jail for a directory THE APP ITSELF DERIVES (from the home dir, `CLAUDE_CONFIG_DIR`, …)
 *  rather than reads out of untrusted content — resolved through symlinks INCLUDING its own final segment,
 *  with any not-yet-created tail appended. A link the user put at their own config dir is their setup (a
 *  dotfiles repo), and the tools that READ that directory follow it, so refusing to write through it seeds
 *  nothing the reader will load while granting no protection: whatever could plant the link can already
 *  write the directory. Confinement still holds INSIDE the resolved root — a link under it that escapes is
 *  still refused (CWE-22/59). Null when the path cannot be reduced to a symlink-free real path. */
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
