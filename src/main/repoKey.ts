// Resolve a cwd to its todo-list scope key (§16.3): the nearest ancestor
// directory containing `.git` (the repo root), or the directory itself when the
// cwd is not inside a repo. A `.git` *file* (worktrees / submodules) counts as a
// root just like a `.git` directory. Returned keys are always absolute, so the
// same repo maps to one stable on-disk todo file regardless of how cwd was spelled.

import { existsSync } from 'node:fs';
import path from 'node:path';
import type { RepoInfo } from '../shared/ipc';

export function resolveRepoKey(cwd: string): string {
  const start = path.resolve(cwd);
  let dir = start;
  for (;;) {
    if (existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return start; // reached filesystem root, no repo
    dir = parent;
  }
}

/**
 * The repo to scope todos to (§16.3), backing `monitor:currentRepo`. Prefers the OSC 7-tracked
 * cwd/key, but **falls back to the spawn cwd** (i.e. $HOME) when nothing is tracked yet — the
 * same fallback the artifact viewer uses (§20.1). Without it, the todo path has a null repo key
 * until the first OSC 7 (or forever, if integration is unavailable), so todos silently no-op in
 * the spawn directory.
 */
export function currentRepoInfo(
  trackedCwd: string | null,
  trackedKey: string | null,
  fallbackCwd: string,
): RepoInfo {
  const cwd = trackedCwd ?? fallbackCwd;
  return { cwd, repoKey: trackedKey ?? resolveRepoKey(cwd) };
}
