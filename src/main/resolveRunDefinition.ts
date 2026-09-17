// A2 (#133) §18.7.3 — the run-scoped flow-definition resolver; pointer/catalogEntry are injected seams
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

type CatalogDegradeCause = Extract<CatalogResolution, { ok: false }>['cause'];

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
    if (hasFlowDefinition(localDir)) return { load: loadFlowDefinition(localDir) };
    const fallback = (): FlowLoad => loadFlowDefinitionLocalFirst(localDir, globalDir);
    const pointer = deps.pointer();
    switch (pointer.kind) {
      case 'unset':
        return { load: fallback() };
      case 'degrade':
        // A degrade carries the pointer store's own reason (§18.7.6); it flows through verbatim — display
        // sanitization is the flow view's boundary, not this resolver's.
        return { load: fallback(), selectionReason: pointer.reason };
      case 'value': {
        const entry = deps.catalogEntry(pointer.id);
        if (entry.ok) return { load: loadFlowDefinitionFromFile(path.join(entry.flowDir, FLOW_DEF_FILE)) };
        return { load: fallback(), selectionReason: catalogDegradeReason(pointer.id, entry.cause) };
      }
      default: {
        const unhandled: never = pointer;
        return unhandled;
      }
    }
  };
}

/** §18.7.6 degrade taxonomy. */
const CATALOG_DEGRADE_DETAIL: Record<CatalogDegradeCause, string> = {
  unknown: 'was not found in the catalog',
  escapes: 'resolves outside its catalog directory',
  unresolvable: 'could not be read',
};

function catalogDegradeReason(id: string, cause: CatalogDegradeCause): string {
  return `Selected flow "${id}" ${CATALOG_DEGRADE_DETAIL[cause]}; running the default flow instead.`;
}
