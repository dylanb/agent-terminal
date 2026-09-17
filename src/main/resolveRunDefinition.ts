// A2 (#133) §18.7.3 — the run-scoped flow-definition resolver, injected as createFlowManager's widened
// `loadDefinition` seam. The catalog-entry and pointer dependencies are injected domain-concept seams
// (CLAUDE.md injection-seam rule).

import path from 'node:path';
import {
  FLOW_DEF_FILE,
  hasFlowDefinition,
  loadFlowDefinition,
  loadFlowDefinitionFromFile,
  loadFlowDefinitionLocalFirst,
  type FlowLoad,
} from './flow';

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

export function createResolveRunDefinition(deps: ResolveRunDefinitionDeps): ResolveRunDefinition {
  return (localDir, globalDir) => {
    // Leg 1 gates on presence, not validity: a present-but-invalid local flow.yaml must surface its own error
    // rather than fall through to the fallback (loadFlowDefinitionLocalFirst's back-compat precedence).
    if (hasFlowDefinition(localDir)) return { load: loadFlowDefinition(localDir) };
    const pointer = deps.pointer();
    if (pointer.kind === 'value') {
      const entry = deps.catalogEntry(pointer.id);
      // A catalog entry's flow.yaml sits directly at <flowDir>/flow.yaml (§18.7.6), not in a `.agent-terminal`
      // subdir, so it loads through the shared file-path validator, not the home-root loadFlowDefinition.
      if (entry.ok) return { load: loadFlowDefinitionFromFile(path.join(entry.flowDir, FLOW_DEF_FILE)) };
    }
    return { load: loadFlowDefinitionLocalFirst(localDir, globalDir) };
  };
}
