// A2 (#133) §18.7.6 — per-tier resolution of a pointer-named catalog id to its on-disk entry directory. This
// is the resolver's `catalogEntry()` producer: it probes the repo tier (untrusted ground) first, then
// the global tier (app-owned ground), so a per-repo entry wins a name clash (§18.1 merged-library precedence).
// The confined RESOLVED path is what the caller opens (never a re-resolution of the raw id, CWE-367/22/59).

import { existsSync } from 'node:fs';
import path from 'node:path';
import { FLOWS_CATALOG_SUBDIR, FLOW_DEF_FILE, FLOW_HOME_SUBDIR, catalogEntryDefFile, flowCatalogDir } from './flow';
import { confinedRealPathResult, resolveJail, resolveOwnedDirJail, type PathRefusal } from './confinedPath';
import { isSafeCatalogId } from '../shared/pathSegment';
import { type CatalogResolution, type CatalogTier } from './resolveRunDefinition';

/** The two roots a pointer-named id is resolved against: the untrusted worktree, and the app-owned global. */
export interface CatalogRoots {
  worktreeDir: string;
  globalRoot: string;
}

/** The listing walks and resolution probes this one jail; a second derivation of either tier's root lets the
 *  picker offer an entry the resolver then refuses (CLAUDE.md writer↔reader rule). */
export function catalogTierJail(roots: CatalogRoots, tier: CatalogTier): string | null {
  return tier === 'repo'
    ? resolveJail(roots.worktreeDir, FLOW_HOME_SUBDIR, FLOWS_CATALOG_SUBDIR)
    : resolveOwnedDirJail(flowCatalogDir(roots.globalRoot));
}

type TierProbe =
  | { kind: 'entry'; flowDir: string }
  | { kind: 'absent' }
  | { kind: 'refused'; cause: PathRefusal };

/** Probe one tier for the entry def-file. An ABSENT entry (its confined path resolves to a would-be location
 *  that does not exist) is `absent` — the caller falls through to the next tier; a jail that will not resolve,
 *  or a path escaping/unresolvable under it, is `refused` — an unreadable tier is never treated as empty (the
 *  precedence-inversion guard, §18.7.6). */
function probeTier(jail: string | null, id: string, defFile: string): TierProbe {
  if (jail === null) return { kind: 'refused', cause: 'unresolvable' };
  const res = confinedRealPathResult(jail, defFile);
  if (!res.ok) return { kind: 'refused', cause: res.cause };
  if (!existsSync(res.path)) return { kind: 'absent' };
  // CWE-22/59 — the caller re-opens `<flowDir>/flow.yaml` by name, so an entry is accepted only when its real
  // def-file IS `<jail>/<id>/flow.yaml`; a link redirecting it onto any other in-jail file would make that
  // re-open a second, unconfined path.
  if (res.path !== path.join(jail, id, FLOW_DEF_FILE)) return { kind: 'refused', cause: 'escapes' };
  return { kind: 'entry', flowDir: path.dirname(res.path) };
}

/** Resolve `id` across the tiers in precedence order, or — given `tier` — within that one tier only (§18.7.3: a
 *  begun run re-resolves within its exact stored tier). */
export function resolveCatalogEntry(roots: CatalogRoots, id: string, tier?: CatalogTier): CatalogResolution {
  // §18.7.6 — the shared safe-catalog-id gate (charset + length) is the first cut: an unsafe id can never name
  // an installable entry (A1 constrains install names to this same predicate), so it is 'unknown', never walked.
  // Belt-and-braces for the disposition path, whose id comes from persisted (untrusted) state.
  if (!isSafeCatalogId(id)) return { ok: false, cause: 'unknown' };

  // §18.7.6 repo tier first — untrusted ground, so resolveJail (a link planted at the entry cannot adopt its
  // target as the jail); a per-repo entry therefore wins a name clash with the global tier.
  if (tier !== 'global') {
    const repo = probeTier(catalogTierJail(roots, 'repo'), id, catalogEntryDefFile(roots.worktreeDir, id));
    if (repo.kind === 'entry') return { ok: true, tier: 'repo', flowDir: repo.flowDir };
    if (repo.kind === 'refused') return { ok: false, cause: repo.cause };
    if (tier === 'repo') return { ok: false, cause: 'unknown' };
  }

  const glob = probeTier(catalogTierJail(roots, 'global'), id, catalogEntryDefFile(roots.globalRoot, id));
  if (glob.kind === 'entry') return { ok: true, tier: 'global', flowDir: glob.flowDir };
  if (glob.kind === 'refused') return { ok: false, cause: glob.cause };

  return { ok: false, cause: 'unknown' };
}
