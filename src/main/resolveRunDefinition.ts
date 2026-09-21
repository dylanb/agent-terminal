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

/** §18.7.3/§18.7.4 — the run's binding state, folded so a begun run that IS bound carries its source: the
 *  'started' variant requires a disposition, so a supplied binding cannot wire started-ness half-way and fall
 *  through to a live pointer re-read (CWE-841). Discriminated union over the two independent accessors it
 *  replaces (CLAUDE.md injection-seam rule; the `BundleLocation` precedent). The CWE-841 no-swap guarantee binds
 *  only once a disposition is supplied — a consumer may instead defer (see `runBinding`). */
export type RunBinding =
  | { started: Exclude<StartednessSignal, 'started'> }
  | { started: Extract<StartednessSignal, 'started'>; disposition: DispositionRead };

export interface ResolveRunDefinitionDeps {
  pointer: () => PointerRead;
  catalogEntry: (id: string) => CatalogResolution;
  /** A per-call `undefined` return means "no binding opinion" — identical to omitting the seam (live three-leg
   *  chain), so a consumer can consult started-ness yet defer a signal it cannot yet bind (a begun run whose
   *  recorded disposition source is owed by a later slice) to that chain. */
  runBinding?: () => RunBinding | undefined;
}

export interface ResolvedRunDefinition {
  load: FlowLoad;
  selectionReason?: string;
  /** §18.7.3 AC9 — the source this resolution bound to, recorded at the in_progress transition so a begun run
   *  re-resolves the SAME source rather than the live pointer. Set on the never-started live legs (the only path
   *  a fresh run takes to in_progress); the already-bound path leaves it undefined (the binding is persisted). */
  binding?: DispositionRead;
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
    if (hasFlowDefinition(localDir)) {
      return { load: loadFlowDefinition(localDir), binding: { source: 'non-catalog' } };
    }
    const fallback = (): FlowLoad => loadFlowDefinitionLocalFirst(localDir, globalDir);
    const pointer = deps.pointer();
    switch (pointer.kind) {
      case 'unset':
        return { load: fallback(), binding: { source: 'non-catalog' } };
      case 'degrade':
        // §18.7.6 / CWE-116/117 — the reason is display-sanitized at its source (the pointer read strips and
        // bounds the echoed rejected value), so the resolver forwards it as-is: one strip at the source, with
        // no second copy here to diverge from it.
        return withDegradeReason(fallback(), pointer.reason);
      case 'value': {
        const entry = deps.catalogEntry(pointer.id);
        if (entry.ok) {
          return {
            load: loadCatalogEntryDefinition(entry.flowDir),
            binding: { source: 'catalog', tier: entry.tier, id: pointer.id },
          };
        }
        return withDegradeReason(fallback(), catalogDegradeReason(pointer.id, entry.cause));
      }
      default:
        pointer satisfies never;
        return { load: fallback(), binding: { source: 'non-catalog' } };
    }
  };
}

/** §18.7.6 — a degrade reason rides only a RUNNING fallback: when the fallback itself fails to load, the degrade
 *  is subsumed by the §18.1 load error, so the reason is dropped. Upholds the `FlowStateView.selectionReason`
 *  invariant (ipc.ts) — never carried with `status: 'error'` — that the renderer's error branch relies on. */
function withDegradeReason(load: FlowLoad, reason: string): ResolvedRunDefinition {
  // A degrade always ran a non-catalog fallback (leg 1 local or leg 3 global), so a begun run binds non-catalog.
  const binding: DispositionRead = { source: 'non-catalog' };
  return load.ok ? { load, selectionReason: reason, binding } : { load, binding };
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
