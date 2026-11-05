// A2 (#133) §18.7.2 — the per-worktree active-flow pointer's own disjoint file
// (<worktree>/.agent-terminal/active-flow.yaml), the store the resolver's pointer() seam reads and
// writeActiveFlow persists. Disjoint from flow-state.yaml so a wholesale progression write can never clobber
// it and vice-versa (§18.7.2 own-file; the AC8 non-clobber invariant).

import path from 'node:path';
import { rmSync } from 'node:fs';
import yaml from 'js-yaml';
import { atomicWriteFileSync } from './atomicFile';
import { readBoundedNoFollow } from './boundedRead';
import { flowHomeDir, flowHomeLeaf } from './flowHome';
import { isSafeCatalogId, MAX_CATALOG_ID_LENGTH } from '../shared/pathSegment';
import { displaySafeEcho } from '../shared/controlChars';
import type { PointerRead } from './resolveRunDefinition';

export const ACTIVE_FLOW_FILE = 'active-flow.yaml';

/** §18.7.6 (CWE-400): the pointer holds a single catalog id (≤ MAX_CATALOG_ID_LENGTH); a file past this bound
 *  is refused before it is read into memory. Exported so the read boundary and its over-cap test single-source
 *  the threshold. */
export const MAX_POINTER_FILE_BYTES = 4096;

/** The pointer's own-file path under the worktree's app-state home — the one resolver both the writer and the
 *  reader derive the location from, so the write target and the read source cannot drift (CLAUDE.md
 *  writer↔reader single-source). */
export function activeFlowPointerFile(worktreeDir: string): string {
  return path.join(flowHomeDir(worktreeDir), ACTIVE_FLOW_FILE);
}

const confinedPointerFile = (worktreeDir: string): string | null => flowHomeLeaf(worktreeDir, ACTIVE_FLOW_FILE);

const UNREADABLE_REASON = 'The selected flow could not be read; pick another flow or use the default.';
const UNREADABLE: PointerRead = { kind: 'invalid', reason: UNREADABLE_REASON };

const displaySafeId = (value: string): string => displaySafeEcho(value, MAX_CATALOG_ID_LENGTH);

const invalidIdReason = (value: string): string =>
  `Selected flow "${displaySafeId(value)}" is not a valid flow id; pick another flow or use the default.`;

/** Persist `id` as the worktree's active-flow selection, written as a structured value never
 *  string-concatenated (CWE-78). Throws when `id` fails the gate readActiveFlow applies, or when the pointer
 *  path is unresolvable — a symlink escaping the worktree (CWE-22/59) or a container that is not a real
 *  directory. */
export function writeActiveFlow(worktreeDir: string, id: string): void {
  if (!isSafeCatalogId(id)) throw new Error(`"${displaySafeId(id)}" is not a valid flow id`);
  const file = confinedPointerFile(worktreeDir);
  if (file === null) throw new Error('active-flow pointer path is unresolvable');
  if (!atomicWriteFileSync(file, yaml.dump(id))) {
    throw new Error(`cannot write active-flow pointer: ${path.dirname(file)} is not a real directory`);
  }
}

/** Return the worktree to the unset default — best-effort; an absent file is already the cleared state. A
 *  non-file at the pointer path is removed too, or a refused pick would have no route out (operator decision
 *  2026-09-25, #134); the gate's read-back reports a removal that did not land. */
export function clearActiveFlow(worktreeDir: string): void {
  const file = confinedPointerFile(worktreeDir);
  if (file === null) return;
  try {
    rmSync(file, { recursive: true, force: true });
  } catch {
    // A partial removal must not throw into the caller; activeFlowGate's read-back surfaces it.
  }
}

/** §18.7.6 — read the pointer as the resolver's pointer() producer. Only a genuine ENOENT is `unset`; a
 *  confinement escape of the pointer's own path, a non-ENOENT errno, an unparseable/non-scalar node, or a
 *  value failing the shared safe-catalog-ID gate is `invalid` with a reason, which refuses the run (never
 *  silently swaps the operator's selection, and never opens a redirect target). */
export function readActiveFlow(worktreeDir: string): PointerRead {
  const file = confinedPointerFile(worktreeDir);
  if (file === null) return UNREADABLE;
  const read = readBoundedNoFollow(file, MAX_POINTER_FILE_BYTES);
  if (!read.ok) return read.cause === 'absent' ? { kind: 'unset' } : UNREADABLE;
  let doc: unknown;
  try {
    doc = yaml.load(read.text);
  } catch {
    return UNREADABLE;
  }
  if (typeof doc !== 'string') return UNREADABLE;
  if (!isSafeCatalogId(doc)) return { kind: 'invalid', reason: invalidIdReason(doc) };
  return { kind: 'value', id: doc };
}
