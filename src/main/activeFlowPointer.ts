// A2 (#133) §18.7.2 — the per-worktree active-flow pointer's own disjoint file
// (<worktree>/.agent-terminal/active-flow.yaml), the store the resolver's leg-2 pointer() seam reads and
// writeActiveFlow persists. Disjoint from flow-state.yaml so a wholesale progression write can never clobber
// it and vice-versa (§18.7.2 own-file; the AC8 non-clobber invariant).

import path from 'node:path';
import { readFileSync, rmSync, statSync } from 'node:fs';
import yaml from 'js-yaml';
import { atomicWriteFileSync } from './atomicFile';
import { confinedRealPath, resolveJail } from './confinedPath';
import { isErrno } from './errno';
import { FLOW_HOME_SUBDIR, flowHomeDir } from './flow';
import { isSafeCatalogId } from '../shared/pathSegment';
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

/** §18.7.2 — the confined absolute pointer-file path, or null when the flow home cannot be reduced to a
 *  symlink-free real path under the worktree (a link planted at `.agent-terminal` or the pointer leaf never
 *  adopts its target, CWE-22/59). Confined through resolveJail because the flow home sits inside the untrusted
 *  worktree. */
function confinedPointerFile(worktreeDir: string): string | null {
  const jail = resolveJail(worktreeDir, FLOW_HOME_SUBDIR);
  if (jail === null) return null;
  return confinedRealPath(jail, activeFlowPointerFile(worktreeDir));
}

const UNREADABLE_REASON = 'The selected flow could not be read; running the default flow instead.';
/** Every read failure that is not a genuine ENOENT (unset) and not a well-formed-but-unsafe id converges here:
 *  an unresolvable path, an over-cap file, a non-ENOENT errno, and an unparseable/non-scalar node all degrade
 *  with the one generic reason. The lone value-specific reason is `invalidIdReason`. */
const UNREADABLE: PointerRead = { kind: 'degrade', reason: UNREADABLE_REASON };
const invalidIdReason = (value: string): string =>
  `Selected flow "${value}" is not a valid flow id; running the default flow instead.`;

/** Persist `id` as the worktree's active-flow selection, written as a structured value never
 *  string-concatenated (CWE-78). Throws when the pointer path is unresolvable — a symlink escaping the
 *  worktree (CWE-22/59) or a container that is not a real directory. */
export function writeActiveFlow(worktreeDir: string, id: string): void {
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
  let text: string;
  try {
    // §18.7.6 / CWE-400
    if (statSync(file).size > MAX_POINTER_FILE_BYTES) return UNREADABLE;
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if (isErrno(e, 'ENOENT')) return { kind: 'unset' };
    return UNREADABLE;
  }
  let doc: unknown;
  try {
    doc = yaml.load(text);
  } catch {
    return UNREADABLE;
  }
  if (typeof doc !== 'string') return UNREADABLE;
  if (!isSafeCatalogId(doc)) return { kind: 'degrade', reason: invalidIdReason(doc) };
  return { kind: 'value', id: doc };
}
