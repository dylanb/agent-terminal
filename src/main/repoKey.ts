// Resolve a cwd to its todo-list scope key (§16.3): the nearest ancestor
// directory containing `.git` (the repo root), or the directory itself when the
// cwd is not inside a repo. A `.git` *file* (worktrees / submodules) counts as a
// root just like a `.git` directory. Returned keys are always absolute, so the
// same repo maps to one stable on-disk todo file regardless of how cwd was spelled.

import { existsSync } from 'node:fs';
import path from 'node:path';

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
