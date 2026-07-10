// The one path-confinement primitive for the main process (CLAUDE.md — never hand-rolled). It is not in
// `src/shared/` because it needs `node:fs`, and `src/shared/` must stay importable by the renderer.

import { realpathSync } from 'node:fs';
import path from 'node:path';

/** The real path of `p`, resolving symlinks in its longest EXISTING prefix and appending the not-yet-created
 *  tail — so a path whose final segments do not exist yet still resolves any linked ancestor. Never throws. */
export function realpathBounded(p: string): string {
  const tail: string[] = [];
  let cur = p;
  for (;;) {
    try {
      return path.join(realpathSync(cur), ...tail.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** A confinement directory: `anchorDir` resolved through symlinks, then `segments` joined literally and
 *  never resolved. Null when `anchorDir` does not resolve. CWE-59. */
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
  return real === jail || real.startsWith(jail + path.sep) ? real : null;
}
