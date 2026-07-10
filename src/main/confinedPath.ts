// The one path-confinement primitive for the main process (CLAUDE.md — never hand-rolled). It is not in
// `src/shared/` because it needs `node:fs`, and `src/shared/` must stay importable by the renderer.

import { realpathSync, lstatSync } from 'node:fs';
import path from 'node:path';

function pathExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** The symlink-free real path of `p`: symlinks in its longest existing prefix are resolved and a tail of
 *  not-yet-created segments is appended. Null when an existing segment is a symlink that does not resolve
 *  (a dangling link), which cannot be reduced to a symlink-free path. Never throws. */
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
      if (pathExists(cur)) return null;
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

/** `target`'s symlink-free real path when it stays inside `jail`, else null. `jail` must already be
 *  resolved (see `resolveJail`); callers use the returned path directly, not the original. Existence of
 *  `target` is the caller's concern. CWE-22, CWE-59, CWE-367. */
export function confinedRealPath(jail: string, target: string): string | null {
  const real = realpathBounded(path.resolve(target));
  if (real === null) return null;
  const prefix = jail.endsWith(path.sep) ? jail : jail + path.sep;
  return real === jail || real.startsWith(prefix) ? real : null;
}
