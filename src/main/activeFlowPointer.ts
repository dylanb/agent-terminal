// A2 (#133) §18.7.2 — the per-worktree active-flow pointer's own disjoint file
// (<worktree>/.agent-terminal/active-flow.yaml), the store the resolver's leg-2 pointer() seam reads and the
// flow:setActiveFlow write gate persists. Disjoint from flow-state.yaml so a wholesale progression write can
// never clobber it and vice-versa (§18.7.2 own-file; the AC8 non-clobber invariant).
//
// TODO(#133 slice-5 GREEN): implement the confined, first-run-capable, atomic write (resolveJail +
// atomicWriteFileSync, mirroring appLoopState.ts's stepFlag/loopAreaFile) and the bounded/field-validated
// read + clear. This stub does not yet persist the pointer, so slice-5's AC10 (first-run-absent-root: the
// write creates the full .agent-terminal path and reads back the id) and AC8 (a pointer write persists
// without touching the disjoint progression file) pins fail by assertion — the write creates nothing and the
// read stays unset.

import path from 'node:path';
import { flowHomeDir } from './flow';
import { type PointerRead } from './resolveRunDefinition';

export const ACTIVE_FLOW_FILE = 'active-flow.yaml';

/** The pointer's own-file path under the worktree's app-state home — the one resolver both the writer and the
 *  reader derive the location from, so the write target and the read source cannot drift (CLAUDE.md
 *  writer↔reader single-source). */
export function activeFlowPointerFile(worktreeDir: string): string {
  return path.join(flowHomeDir(worktreeDir), ACTIVE_FLOW_FILE);
}

export function writeActiveFlow(_worktreeDir: string, _id: string): void {
  // not yet implemented (slice-5 GREEN)
}

export function clearActiveFlow(_worktreeDir: string): void {
  // not yet implemented (slice-5 GREEN)
}

export function readActiveFlow(_worktreeDir: string): PointerRead {
  return { kind: 'unset' };
}
