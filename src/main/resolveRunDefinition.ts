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
import { type StartednessSignal } from '../shared/flowStarted';

/** §18.7.2 read of the per-worktree active-flow pointer that the resolver's leg 2 consults. */
export type PointerRead =
  | { kind: 'unset' }
  | { kind: 'value'; id: string }
  | { kind: 'degrade'; reason: string };

/** §18.7.6 the two catalog tiers a pointer-named id can resolve within (per-repo untrusted, or app-owned global). */
export type CatalogTier = 'repo' | 'global';

/** §18.7.6 per-tier resolution of a pointer-named catalog id to its on-disk entry directory. */
export type CatalogResolution =
  | { ok: true; tier: CatalogTier; flowDir: string }
  | { ok: false; cause: 'unknown' | 'escapes' | 'unresolvable' };

type CatalogDegradeCause = Extract<CatalogResolution, { ok: false }>['cause'];

/** §18.7.3 — the run-scoped source binding a begun run resolves instead of the live pointer. A validated closed
 *  disposition (its field-local validation is the read boundary's): a catalog run carries the tier it was bound
 *  to plus its id; a non-catalog run carries neither and keeps the live local↔global chain. */
export type DispositionRead =
  | { source: 'catalog'; tier: CatalogTier; id: string }
  | { source: 'non-catalog' };

/** §18.7.3/§18.7.4 — the run's binding state, folded so that a begun run ALWAYS carries the source it is bound
 *  to: "started without a disposition" is unrepresentable, so no consumer can wire started-ness half-way and
 *  silently fall through to a live pointer re-read (CWE-841). Discriminated union over the two independent
 *  accessors it replaces (CLAUDE.md injection-seam rule; the `BundleLocation` precedent). Omitted entirely by a
 *  consumer that does not yet consult started-ness — resolution is then the live three-leg chain. */
export type RunBinding =
  | { started: Exclude<StartednessSignal, 'started'> }
  | { started: Extract<StartednessSignal, 'started'>; disposition: DispositionRead };

export interface ResolveRunDefinitionDeps {
  pointer: () => PointerRead;
  catalogEntry: (id: string) => CatalogResolution;
  runBinding?: () => RunBinding;
}

export interface ResolvedRunDefinition {
  load: FlowLoad;
  selectionReason?: string;
}

export type ResolveRunDefinition = (localDir: string, globalDir: string) => ResolvedRunDefinition;

export function createResolveRunDefinition(deps: ResolveRunDefinitionDeps): ResolveRunDefinition {
  return (localDir, globalDir) => {
    // §18.7.4 / §18.7.3 / CWE-841 — a begun run's source is decided before every leg, not only the pointer: an
    // unverifiable progression may be a begun catalog run, and re-resolving (to the pointer, or to a
    // mid-run-added local flow.yaml) would swap its bound source out from under it. The binding carries its
    // disposition with the 'started' signal, so a begun run can never fall through to live re-resolution.
    const binding = deps.runBinding?.();
    if (binding) {
      switch (binding.started) {
        case 'indeterminate':
          return { load: indeterminateHold() };
        case 'started':
          return resolveBoundSource(binding.disposition, deps.catalogEntry, localDir, globalDir);
        case 'never-started':
          break;
        default:
          binding satisfies never;
      }
    }
    if (hasFlowDefinition(localDir)) return { load: loadFlowDefinition(localDir) };
    const fallback = (): FlowLoad => loadFlowDefinitionLocalFirst(localDir, globalDir);
    const pointer = deps.pointer();
    switch (pointer.kind) {
      case 'unset':
        return { load: fallback() };
      case 'degrade':
        // §18.7.6 / CWE-116/117 — whatever renders this reason must display-strip control/bidi bytes, never
        // this resolver: one strip at the render boundary, with no second copy here to diverge from it.
        return { load: fallback(), selectionReason: pointer.reason };
      case 'value': {
        const entry = deps.catalogEntry(pointer.id);
        if (entry.ok) return { load: loadCatalogEntryDefinition(entry.flowDir) };
        return { load: fallback(), selectionReason: catalogDegradeReason(pointer.id, entry.cause) };
      }
      default:
        pointer satisfies never;
        return { load: fallback() };
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

function loadCatalogEntryDefinition(flowDir: string): FlowLoad {
  return loadFlowDefinitionFromFile(path.join(flowDir, FLOW_DEF_FILE));
}

function resolveBoundSource(
  disposition: DispositionRead,
  catalogEntry: (id: string) => CatalogResolution,
  localDir: string,
  globalDir: string,
): ResolvedRunDefinition {
  switch (disposition.source) {
    case 'catalog': {
      // §18.7.3 / CWE-841 — re-resolve the bound id and require it to land in the SAME tier it was bound to; a
      // tier mismatch (a same-named entry now winning in another tier) or a lost entry is the §18.1 error state,
      // never a silent swap to a different source.
      const entry = catalogEntry(disposition.id);
      if (!entry.ok || entry.tier !== disposition.tier) return { load: lostBindingHold() };
      return { load: loadCatalogEntryDefinition(entry.flowDir) };
    }
    case 'non-catalog':
      return { load: loadFlowDefinitionLocalFirst(localDir, globalDir) };
    default:
      // §18.7.6 — a persisted source outside the closed set (on-disk corruption the type cannot catch at
      // runtime) fails closed to the §18.1 error, never a fall-open to the live local↔global chain.
      disposition satisfies never;
      return { load: lostBindingHold() };
  }
}

function indeterminateHold(): FlowLoad {
  return { ok: false, error: "the run's progression state could not be verified" };
}

function lostBindingHold(): FlowLoad {
  return { ok: false, error: "the run's recorded flow source could not be resolved" };
}
