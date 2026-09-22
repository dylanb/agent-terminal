// A2 (#133) §18.7.2/§18.7.3/§18.7.4 — the run-disposition own-file
// (<worktree>/.agent-terminal/run-disposition.yaml). Its PRESENCE is the durable "run has begun" marker that
// gates a new active-flow selection (worktreeStartedness/§18.7.4 AC7); its CONTENTS are the run-scoped source
// binding a begun run re-resolves instead of the live pointer (§18.7.3 AC9), so a begun run never silently
// switches which tier/entry supplies its definition (CWE-841). Recorded when a run transitions to in_progress
// and cleared only by a Terminate, so it survives a first-step revertStep that rolls the display status back to
// not_started. Disjoint from flow-state.yaml (own-file) so a wholesale progression write can neither clobber
// nor resurrect it (§18.7.2, the AC8 non-clobber invariant); mirrors activeFlowPointer.ts's own-file shape and
// confinement.

import path from 'node:path';
import { readFileSync, rmSync, statSync } from 'node:fs';
import yaml from 'js-yaml';
import { atomicWriteFileSync } from './atomicFile';
import { confinedRealPath, resolveJail } from './confinedPath';
import { isErrno } from './errno';
import { isRecord } from './yamlRecord';
import { isSafeCatalogId } from '../shared/pathSegment';
import type { CatalogTier, DispositionRead } from './resolveRunDefinition';

// The worktree app-state home the marker shares with flow-state.yaml (§19.1). Held as a local const — as
// flowState.ts holds its own — so this leaf, which flow.ts's createFlowManager imports, does not import flow.ts
// back and form a cycle.
const AGENT_DIR = '.agent-terminal';

export const RUN_DISPOSITION_FILE = 'run-disposition.yaml';
export const RUN_DISPOSITION_SCHEMA = 1;

/** §18.7.6 (CWE-400): the binding is a handful of short scalars; a file past this bound is refused before it is
 *  read into memory, so a begun run whose disposition cannot be verified fails closed rather than parsing an
 *  attacker-sized document. */
export const MAX_DISPOSITION_FILE_BYTES = 4096;

const CATALOG_TIERS: ReadonlySet<CatalogTier> = new Set(['repo', 'global']);

function isCatalogTier(v: unknown): v is CatalogTier {
  return typeof v === 'string' && (CATALOG_TIERS as ReadonlySet<string>).has(v);
}

/** The disposition own-file path — the one resolver the writer and reader both derive the location from, so the
 *  write target and the read source cannot drift (CLAUDE.md writer↔reader single-source). */
export function runDispositionFile(worktreeDir: string): string {
  return path.join(worktreeDir, AGENT_DIR, RUN_DISPOSITION_FILE);
}

/** §18.7.2 — the confined absolute disposition-file path, or null when the flow home cannot be reduced to a
 *  symlink-free real path under the worktree (a link planted at `.agent-terminal` or the leaf never adopts its
 *  target, CWE-22/59). Confined through resolveJail because the flow home sits inside the untrusted worktree. */
function confinedDispositionFile(worktreeDir: string): string | null {
  const jail = resolveJail(worktreeDir, AGENT_DIR);
  if (jail === null) return null;
  return confinedRealPath(jail, runDispositionFile(worktreeDir));
}

/** §18.7.4 — the marker's read outcome: genuinely absent (never began), present (begun, not yet cleared by a
 *  Terminate), or present-but-unverifiable (fail-closed). */
export type DispositionPresence = 'absent' | 'present' | 'indeterminate';

/** §18.7.3/§18.7.4 — record that a run has begun AND the source it bound to, as a structured value never
 *  string-concatenated (CWE-78), committed atomically with the transition to in_progress. Throws when the path
 *  is unresolvable (a symlink escaping the worktree, CWE-22/59). */
export function recordDisposition(worktreeDir: string, binding: DispositionRead): void {
  const file = confinedDispositionFile(worktreeDir);
  if (file === null) throw new Error('run-disposition path is unresolvable');
  const doc =
    binding.source === 'catalog'
      ? { schema_version: RUN_DISPOSITION_SCHEMA, source: 'catalog', tier: binding.tier, id: binding.id }
      : { schema_version: RUN_DISPOSITION_SCHEMA, source: 'non-catalog' };
  if (!atomicWriteFileSync(file, yaml.dump(doc))) {
    throw new Error(`cannot write run-disposition: ${path.dirname(file)} is not a real directory`);
  }
}

/** Clear the marker at Terminate — best-effort; an absent file is already the cleared state. */
export function clearDisposition(worktreeDir: string): void {
  const file = confinedDispositionFile(worktreeDir);
  if (file === null) return;
  try {
    // `recursive` so a non-file marker planted in untrusted worktree content — a directory at the leaf, which
    // readDisposition reads 'present' — is actually cleared by the Terminate that re-enables selection, not left
    // behind by a non-recursive rm's EISDIR (§18.7.2 AC6/CWE-703). Confined to the marker path, never an escape.
    rmSync(file, { recursive: true, force: true });
  } catch {
    // `force` covers ENOENT; a locked container (EPERM) must not throw into Terminate (best-effort; cf.
    // clearActiveFlow).
  }
}

/** §18.7.4 — read the marker's presence, fail-closed: any unverifiable read — a confinement escape of its own
 *  path, or a non-ENOENT errno — is `indeterminate`, never `absent`, so a corrupt marker cannot read back as
 *  never-begun and unlock a new selection (§18.7.4/CWE-841/CWE-20). */
export function readDisposition(worktreeDir: string): DispositionPresence {
  const file = confinedDispositionFile(worktreeDir);
  if (file === null) return 'indeterminate';
  try {
    statSync(file);
    return 'present';
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
  let text: string;
  try {
    if (statSync(file).size > MAX_DISPOSITION_FILE_BYTES) return null; // CWE-400 fail-closed before reading
    text = readFileSync(file, 'utf8');
  } catch {
    return null; // absent (ENOENT) or unverifiable → null; the use site fails closed to the §18.1 error
  }
  let doc: unknown;
  try {
    doc = yaml.load(text);
  } catch {
    return null;
  }
  return parseRunBinding(doc);
}

/** §18.7.6/CWE-20/CWE-1321 — validate the attacker-supplied disposition document into the closed FlowDisposition
 *  union by explicit known-key extraction (never iterating attacker keys): a catalog binding is trusted only when
 *  BOTH its tier is in the closed set AND its id passes the shared safe-catalog-ID gate; any other shape (unknown
 *  source, missing/typed-wrong fields) fails closed to null. */
function parseRunBinding(doc: unknown): DispositionRead | null {
  if (!isRecord(doc)) return null;
  if (doc.source === 'non-catalog') return { source: 'non-catalog' };
  if (doc.source === 'catalog' && isCatalogTier(doc.tier) && typeof doc.id === 'string' && isSafeCatalogId(doc.id)) {
    return { source: 'catalog', tier: doc.tier, id: doc.id };
  }
  return null;
}
