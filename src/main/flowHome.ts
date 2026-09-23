// §19.1 — the worktree app-state home. A leaf module (no app imports beyond confinedPath) so every own-file store
// derives its location from this one definition without importing flow.ts back.

import path from 'node:path';
import { confinedRealPath, resolveJail } from './confinedPath';

export const FLOW_HOME_SUBDIR = '.agent-terminal';

/** Where a root keeps its flow definition and app state (§18.1/§19.1/§23.4). */
export function flowHomeDir(root: string): string {
  return path.join(root, FLOW_HOME_SUBDIR);
}

/** The own-file `name` directly under a worktree's flow home, as an UNRESOLVED leaf under a symlink-free flow
 *  home, or null when the flow home itself is a link or does not reduce to a real path under the worktree
 *  (CWE-22/59). A caller writes, removes, and (O_NOFOLLOW) opens exactly this path, so a link planted at the leaf
 *  is replaced or refused, never followed onto a sibling (§18.7.2 AC8, CWE-59/73). */
export function flowHomeLeaf(worktreeDir: string, name: string): string | null {
  const jail = resolveJail(worktreeDir, FLOW_HOME_SUBDIR);
  if (jail === null || confinedRealPath(jail, jail) !== jail) return null;
  return path.join(jail, name);
}
