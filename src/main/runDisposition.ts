// A2 (#133) §18.7.2/§18.7.3/§18.7.4 — the run-disposition own-file
// (<worktree>/.agent-terminal/run-disposition.yaml). Its PRESENCE is the durable "run has begun" marker that
// gates a new active-flow selection (worktreeStartedness/§18.7.4 AC7); its CONTENTS are the run-scoped source
// binding a begun run re-resolves instead of the live pointer (§18.7.3 AC9), so a begun run never silently
// switches which tier/entry supplies its definition (CWE-841). Disjoint from flow-state.yaml (own-file) so a
// wholesale progression write can neither clobber nor resurrect it (§18.7.2, the AC8 non-clobber invariant).

import path from 'node:path';
import { lstatSync, rmSync } from 'node:fs';
import yaml from 'js-yaml';
import { atomicWriteFileSync } from './atomicFile';
import { readBoundedNoFollow } from './boundedRead';
import { isErrno } from './errno';
import { flowHomeDir, flowHomeLeaf } from './flowHome';
import { isRecord } from './yamlRecord';
import { isSafeCatalogId } from '../shared/pathSegment';
import { CATALOG_ORIGINS } from '../shared/ipc';
import type { CatalogTier, DispositionRead } from './resolveRunDefinition';

export const RUN_DISPOSITION_FILE = 'run-disposition.yaml';
export const RUN_DISPOSITION_SCHEMA = 1;

/** §18.7.6 (CWE-400): the binding is a handful of short scalars; a file past this bound is refused before it is
 *  read into memory, so a begun run whose disposition cannot be verified fails closed rather than parsing an
 *  attacker-sized document. */
export const MAX_DISPOSITION_FILE_BYTES = 4096;

const CATALOG_TIERS: ReadonlySet<CatalogTier> = new Set(CATALOG_ORIGINS);

function isCatalogTier(v: unknown): v is CatalogTier {
  return typeof v === 'string' && (CATALOG_TIERS as ReadonlySet<string>).has(v);
}

/** The disposition own-file path — the one resolver the writer and reader both derive the location from, so the
 *  write target and the read source cannot drift (CLAUDE.md writer↔reader single-source). */
export function runDispositionFile(worktreeDir: string): string {
  return path.join(flowHomeDir(worktreeDir), RUN_DISPOSITION_FILE);
}

const confinedDispositionFile = (worktreeDir: string): string | null =>
  flowHomeLeaf(worktreeDir, RUN_DISPOSITION_FILE);

/** §18.7.4 — the marker's read outcome: genuinely absent (never began), present (begun, not yet cleared by a
 *  Terminate), or present-but-unverifiable (fail-closed). */
export type DispositionPresence = 'absent' | 'present' | 'indeterminate';

/** §18.7.3/§18.7.4 — record that a run has begun AND the source it bound to, as a structured value never
 *  string-concatenated (CWE-78), committed atomically with the transition to in_progress. Throws when the path
 *  is unresolvable (a symlink escaping the worktree, CWE-22/59). */
export function recordDisposition(worktreeDir: string, binding: DispositionRead): void {
  const file = confinedDispositionFile(worktreeDir);
  if (file === null) throw new Error('run-disposition path is unresolvable');
  if (!atomicWriteFileSync(file, yaml.dump(dispositionDoc(binding)))) {
    throw new Error(`cannot write run-disposition: ${path.dirname(file)} is not a real directory`);
  }
}

function dispositionDoc(binding: DispositionRead): Record<string, unknown> {
  switch (binding.source) {
    case 'catalog':
      return { schema_version: RUN_DISPOSITION_SCHEMA, source: 'catalog', tier: binding.tier, id: binding.id };
    case 'non-catalog':
      return { schema_version: RUN_DISPOSITION_SCHEMA, source: 'non-catalog' };
    case 'fallback':
      return { schema_version: RUN_DISPOSITION_SCHEMA, source: 'fallback' };
    default:
      return binding satisfies never;
  }
}

/** Clear the marker at Terminate or a first-step rollback; an absent file is already the cleared state. Throws when
 *  the marker cannot be removed, so the reset that re-enables selection (§18.7.2 AC6/§18.7.4) is refused rather than
 *  leaving the worktree locked with no retry (CWE-703). */
export function clearDisposition(worktreeDir: string): void {
  const file = confinedDispositionFile(worktreeDir);
  if (file === null) throw new Error('run-disposition path is unresolvable');
  // `recursive` so a directory planted at the leaf (which readDisposition reads 'present') is cleared too.
  rmSync(file, { recursive: true, force: true });
}

/** §18.7.4 — read the marker's presence, fail-closed: any unverifiable read — a confinement escape of its own
 *  path, or a non-ENOENT errno — is `indeterminate`, never `absent`, so a corrupt marker cannot read back as
 *  never-begun and unlock a new selection (§18.7.4/CWE-841/CWE-20). */
export function readDisposition(worktreeDir: string): DispositionPresence {
  const file = confinedDispositionFile(worktreeDir);
  if (file === null) return 'indeterminate';
  try {
    return lstatSync(file).isSymbolicLink() ? 'indeterminate' : 'present';
  } catch (e) {
    return isErrno(e, 'ENOENT') ? 'absent' : 'indeterminate';
  }
}

/** §18.7.3 AC9 — the run-scoped source binding a begun run re-resolves, or null when it is absent or cannot be
 *  verified (a confinement escape, a non-ENOENT errno, an over-cap or unparseable document, or a field that
 *  fails validation). A null on a run whose PRESENCE reads 'started' fails closed at the use site to the §18.1
 *  error rather than a live re-resolution (CWE-20/841). */
export function readRunBinding(worktreeDir: string): DispositionRead | null {
  const file = confinedDispositionFile(worktreeDir);
  if (file === null) return null;
  const read = readBoundedNoFollow(file, MAX_DISPOSITION_FILE_BYTES);
  if (!read.ok) return null;
  let doc: unknown;
  try {
    doc = yaml.load(read.text);
  } catch {
    return null;
  }
  return parseRunBinding(doc);
}

/** §18.7.6/CWE-20/CWE-1321 — validate the attacker-supplied disposition document into the closed DispositionRead
 *  union by explicit known-key extraction (never iterating attacker keys): a catalog binding is trusted only when
 *  BOTH its tier is in the closed set AND its id passes the shared safe-catalog-ID gate; any other shape (unknown
 *  source, missing/typed-wrong fields) fails closed to null. */
function parseRunBinding(doc: unknown): DispositionRead | null {
  if (!isRecord(doc)) return null;
  if (doc.source === 'non-catalog') return { source: 'non-catalog' };
  if (doc.source === 'fallback') return { source: 'fallback' };
  if (doc.source === 'catalog' && isCatalogTier(doc.tier) && typeof doc.id === 'string' && isSafeCatalogId(doc.id)) {
    return { source: 'catalog', tier: doc.tier, id: doc.id };
  }
  return null;
}
