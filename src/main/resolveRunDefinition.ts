// A2 (#133) §18.7.3 — the run-scoped flow-definition resolver, injected as createFlowManager's widened
// `loadDefinition` seam. The catalog-entry and pointer dependencies are injected domain-concept seams
// (CLAUDE.md injection-seam rule), so this module imports none of the leaf stores.
//
// TODO(#133 slice-1 GREEN): implement the three ordered legs — local flow.yaml (leg 1) → the pointer-named
// catalog entry (leg 2) → the global fallback (leg 3). This stub resolves local-first only (pointer-blind),
// so the slice-1 RED fails on the leg-2 pointer case.

import { loadFlowDefinitionLocalFirst, type FlowLoad } from './flow';

/** §18.7.2 read of the per-worktree active-flow pointer that the resolver's leg 2 consults. */
export type PointerRead =
  | { kind: 'unset' }
  | { kind: 'value'; id: string }
  | { kind: 'degrade'; reason: string };

/** §18.7.6 per-tier resolution of a pointer-named catalog id to its on-disk entry directory. */
export type CatalogResolution =
  | { ok: true; tier: 'repo' | 'global'; flowDir: string }
  | { ok: false; cause: 'unknown' | 'escapes' | 'unresolvable' };

export interface ResolveRunDefinitionDeps {
  pointer: () => PointerRead;
  catalogEntry: (id: string) => CatalogResolution;
}

export interface ResolvedRunDefinition {
  load: FlowLoad;
  selectionReason?: string;
}

export type ResolveRunDefinition = (localDir: string, globalDir: string) => ResolvedRunDefinition;

export function createResolveRunDefinition(_deps: ResolveRunDefinitionDeps): ResolveRunDefinition {
  return (localDir, globalDir) => ({ load: loadFlowDefinitionLocalFirst(localDir, globalDir) });
}
