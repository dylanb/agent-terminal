// Resolve a cwd to its todo-list scope key (§16.3). A `.git` *file* (worktrees / submodules) counts
// as a root just like a `.git` directory. Keys are always absolute, so one repo maps to one stable
// on-disk todo file however cwd was spelled.

import { existsSync } from 'node:fs';
import path from 'node:path';
import type { RepoInfo } from '../shared/ipc';

export function resolveRepoKey(cwd: string): string {
  const start = path.resolve(cwd);
  let dir = start;
  for (;;) {
    if (existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

/**
 * The repo to scope todos to (§16.3), backing `monitor:currentRepo`. Falls back to the spawn cwd
 * when nothing is OSC 7-tracked yet — the same fallback the artifact viewer uses (§20.1). Without
 * it, todos would silently no-op in the spawn directory until the first OSC 7 (or forever, if
 * integration is unavailable).
 */
export function currentRepoInfo(
  trackedCwd: string | null,
  trackedKey: string | null,
  fallbackCwd: string,
): RepoInfo {
  const cwd = trackedCwd ?? fallbackCwd;
  return { cwd, repoKey: trackedKey ?? resolveRepoKey(cwd) };
}
