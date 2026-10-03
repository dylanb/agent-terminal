// A2 (#133) §18.7.2 — the per-worktree active-flow pointer's own disjoint file
// (<worktree>/.agent-terminal/active-flow.yaml), the store the resolver's leg-2 pointer() seam reads and
// writeActiveFlow persists. Disjoint from flow-state.yaml so a wholesale progression write can never clobber
// it and vice-versa (§18.7.2 own-file; the AC8 non-clobber invariant).

import path from 'node:path';
import { rmSync } from 'node:fs';
import yaml from 'js-yaml';
import { atomicWriteFileSync } from './atomicFile';
import { readBoundedNoFollow } from './boundedRead';
import { flowHomeDir, flowHomeLeaf } from './flowHome';
import { isSafeCatalogId, MAX_CATALOG_ID_LENGTH } from '../shared/pathSegment';
import { stripDisplayControlChars } from '../shared/controlChars';
import { type PointerRead } from './resolveRunDefinition';

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

const UNREADABLE_REASON = 'The selected flow could not be read; running the default flow instead.';
const UNREADABLE: PointerRead = { kind: 'degrade', reason: UNREADABLE_REASON };

// §18.7.6 (CWE-116/117/1007/400) — stripDisplayControlChars deliberately keeps the U+200C/U+200D joiners for
// legitimate shaping; an echoed rejected catalog id has no legitimate joiner, so they are stripped here too.
const JOINERS = new RegExp('[\\u200C\\u200D]', 'gu');

/** §18.7.6 (CWE-116/117/1007/400) — the rejected value FAILED the safe-id gate, so it may carry
 *  control/bidi/zero-width/BOM/joiner bytes and run to the file cap. Display-sanitize and length-bound it here,
 *  where it is echoed into the human-facing reason, so every downstream sink (the flow view, any §25 audit leg)
 *  receives a display-safe value and the ipc.ts `selectionReason` contract holds. */
const displaySafeId = (value: string): string =>
  stripDisplayControlChars(value).replace(JOINERS, '').slice(0, MAX_CATALOG_ID_LENGTH);

const invalidIdReason = (value: string): string =>
  `Selected flow "${displaySafeId(value)}" is not a valid flow id; running the default flow instead.`;

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

/** Return the worktree to the unset default — best-effort; an absent file is already the cleared state. */
export function clearActiveFlow(worktreeDir: string): void {
  const file = confinedPointerFile(worktreeDir);
  if (file === null) return;
  try {
    rmSync(file, { force: true });
  } catch {
    // `force` covers ENOENT; a non-file (EISDIR) or locked container (EPERM) at the path must not throw into
    // the caller — an unset selection is already the recovered state (CLAUDE.md best-effort; cf. clearTurnDone).
  }
}

/** §18.7.6 — read the pointer as the resolver's leg-2 producer. Only a genuine ENOENT is `unset`; a
 *  confinement escape of the pointer's own path, a non-ENOENT errno, an unparseable/non-scalar node, or a
 *  value failing the shared safe-catalog-ID gate degrades VISIBLY with a reason (never silently swaps the
 *  operator's selection, and never opens a redirect target). */
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
  if (!isSafeCatalogId(doc)) return { kind: 'degrade', reason: invalidIdReason(doc) };
  return { kind: 'value', id: doc };
}
