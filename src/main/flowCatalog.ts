// A2 (#133) §18.7.6 — per-tier resolution of a pointer-named catalog id to its on-disk entry directory. This
// is the resolver's leg-2 `catalogEntry()` producer: it probes the repo tier (untrusted ground) first, then
// the global tier (app-owned ground), so a per-repo entry wins a name clash (§18.1 merged-library precedence).
// The confined RESOLVED path is what the caller opens (never a re-resolution of the raw id, CWE-367/22/59).

import { existsSync } from 'node:fs';
import path from 'node:path';
import { FLOWS_CATALOG_SUBDIR, FLOW_HOME_SUBDIR, catalogEntryDefFile, flowCatalogDir } from './flow';
import { confinedRealPathResult, resolveJail, resolveOwnedDirJail, type PathRefusal } from './confinedPath';
import { isSafeCatalogId } from '../shared/pathSegment';
import { type CatalogResolution } from './resolveRunDefinition';

/** The two roots a pointer-named id is resolved against: the untrusted worktree, and the app-owned global. */
export interface CatalogRoots {
  worktreeDir: string;
  globalRoot: string;
}

type TierProbe =
  | { kind: 'entry'; flowDir: string }
  | { kind: 'absent' }
  | { kind: 'degrade'; cause: PathRefusal };

/** Probe one tier for the entry def-file. An ABSENT entry (its confined path resolves to a would-be location
 *  that does not exist) is `absent` — the caller falls through to the next tier; a jail that will not resolve,
 *  or a path escaping/unresolvable under it, is a `degrade` — an unreadable tier is never treated as empty (the
 *  precedence-inversion guard, §18.7.6). */
function probeTier(jail: string | null, defFile: string): TierProbe {
  if (jail === null) return { kind: 'degrade', cause: 'unresolvable' };
  const res = confinedRealPathResult(jail, defFile);
  if (!res.ok) return { kind: 'degrade', cause: res.cause };
  if (!existsSync(res.path)) return { kind: 'absent' };
  return { kind: 'entry', flowDir: path.dirname(res.path) };
}

export function resolveCatalogEntry(roots: CatalogRoots, id: string): CatalogResolution {
  // §18.7.6 — the shared safe-catalog-id gate (charset + length) is the first cut: an unsafe id can never name
  // an installable entry (A1 constrains install names to this same predicate), so it is 'unknown', never walked.
  // Belt-and-braces for the disposition path, whose id comes from persisted (untrusted) state.
  if (!isSafeCatalogId(id)) return { ok: false, cause: 'unknown' };

  // §18.7.6 repo tier first — untrusted ground, so resolveJail (a link planted at the entry cannot adopt its
  // target as the jail); a per-repo entry therefore wins a name clash with the global tier.
  const repo = probeTier(
    resolveJail(roots.worktreeDir, FLOW_HOME_SUBDIR, FLOWS_CATALOG_SUBDIR),
    catalogEntryDefFile(roots.worktreeDir, id),
  );
  if (repo.kind === 'entry') return { ok: true, tier: 'repo', flowDir: repo.flowDir };
  if (repo.kind === 'degrade') return { ok: false, cause: repo.cause };

  // The repo tier has no such member → the global tier (app-owned ground → resolveOwnedDirJail).
  const glob = probeTier(
    resolveOwnedDirJail(flowCatalogDir(roots.globalRoot)),
    catalogEntryDefFile(roots.globalRoot, id),
  );
  if (glob.kind === 'entry') return { ok: true, tier: 'global', flowDir: glob.flowDir };
  if (glob.kind === 'degrade') return { ok: false, cause: glob.cause };

  return { ok: false, cause: 'unknown' };
}
