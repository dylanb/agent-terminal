// #180 — a confined walk of a directory of flow documents, shared by `bench capture` (a working folder's loop
// artifacts) and `bench run` (a fixture's artifacts).

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { confinedRealPathResult } from './confinedPath';
import { readDirEntries } from './dirEntries';

export type ConfinedTree = { ok: true; files: Map<string, Buffer> } | { ok: false };

/** Every file under `jail`, relative path → bytes, each entry confined to `jail` (CWE-22/59); empty when `jail`
 *  is absent. `jail` comes from `resolveJail`, so a link at its own last segment is refused, never followed. */
export function readConfinedTree(jail: string | null): ConfinedTree {
  if (jail === null) return { ok: false };
  const files = new Map<string, Buffer>();
  // The directories on the current path only, so a link back up is not followed while a link to a sibling is.
  const ancestors = new Set<string>();
  const walk = (real: string, rel: string): boolean => {
    if (ancestors.has(real)) return true;
    ancestors.add(real);
    for (const entry of readDirEntries(real)) {
      const res = confinedRealPathResult(jail, path.join(real, entry.name));
      if (!res.ok) return false;
      const entryRel = rel === '' ? entry.name : path.join(rel, entry.name);
      const stat = statSync(res.path);
      if (stat.isDirectory()) {
        if (!walk(res.path, entryRel)) return false;
      } else if (stat.isFile()) files.set(entryRel, readFileSync(res.path));
    }
    ancestors.delete(real);
    return true;
  };
  const root = confinedRealPathResult(jail, jail);
  return root.ok && walk(root.path, '') ? { ok: true, files } : { ok: false };
}
