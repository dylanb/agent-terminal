// A2 (#133) §18.7.3 — the run-scoped flow-definition resolver; pointer/catalogEntry are injected seams
// (CLAUDE.md injection-seam rule).

import path from 'node:path';
import {
  loadFlowDefinition,
  loadUntrustedFlowDefinition,
  loadFlowDefinitionLocalFirst,
  type FlowLoad,
} from './flow';
import type { StartednessSignal } from '../shared/flowStarted';
import type { CatalogOrigin } from '../shared/ipc';
import { FLOW_DEF_FILE } from './flowHome';

/** §18.7.2 read of the per-worktree active-flow pointer, which the resolver consults first. */
export type PointerRead =
  | { kind: 'unset' }
  | { kind: 'value'; id: string }
  | { kind: 'invalid'; reason: string };

/** §18.7.6 the two catalog tiers a pointer-named id can resolve within (per-repo untrusted, or app-owned global). */
export type CatalogTier = CatalogOrigin;

/** §18.7.6 per-tier resolution of a pointer-named catalog id to its on-disk entry directory. */
export type CatalogResolution =
  | { ok: true; tier: CatalogTier; flowDir: string }
  | { ok: false; cause: 'unknown' | 'escapes' | 'unresolvable' };

export type CatalogRefusalCause = Extract<CatalogResolution, { ok: false }>['cause'];

/** §18.7.3 — the run-scoped source binding a begun run resolves instead of the live pointer. A validated closed
 *  disposition (its field-local validation is the read boundary's): a catalog run carries the tier it was bound
 *  to plus its id; a non-catalog run carries neither and keeps the live local↔global chain; a fallback run
 *  (written only by held-run recovery) loads the global fallback alone. */
export type DispositionRead =
  | { source: 'catalog'; tier: CatalogTier; id: string }
  | { source: 'non-catalog' }
  | { source: 'fallback' };

/** §18.7.3/§18.7.4 — the run's binding state, folded so a begun run that IS bound carries its source: the
 *  'started' variant requires a disposition, so a supplied binding cannot wire started-ness half-way and fall
 *  through to a live pointer re-read (CWE-841). Discriminated union over the two independent accessors it
 *  replaces (CLAUDE.md injection-seam rule; the `BundleLocation` precedent). */
export type RunBinding =
  | { started: Exclude<StartednessSignal, 'started'> }
  | { started: Extract<StartednessSignal, 'started'>; disposition: DispositionRead };

export interface ResolveRunDefinitionDeps {
  pointer: () => PointerRead;
  /** Resolve `id` across the tiers in precedence order, or within `tier` only when one is given. */
  catalogEntry: (id: string, tier?: CatalogTier) => CatalogResolution;
  runBinding?: () => RunBinding;
}

export interface ResolvedRunDefinition {
  load: FlowLoad;
  /** §18.7.3 AC9 — the source this resolution bound to, recorded at the in_progress transition so a begun run
   *  re-resolves the SAME source rather than the live pointer. Absent on a refused pick or a held begun run. */
  binding?: DispositionRead;
}

function localFirst(localDir: string, globalDir: string, binding: DispositionRead): ResolvedRunDefinition {
  return { load: loadFlowDefinitionLocalFirst(localDir, globalDir), binding };
}

export type ResolveRunDefinition = (localDir: string, globalDir: string) => ResolvedRunDefinition;

export function createResolveRunDefinition(deps: ResolveRunDefinitionDeps): ResolveRunDefinition {
  return (localDir, globalDir) => {
    // §18.7.4 / §18.7.3 / CWE-841 — a begun run's source is decided before any source is consulted: an
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
    const pointer = deps.pointer();
    switch (pointer.kind) {
      case 'unset':
        return localFirst(localDir, globalDir, { source: 'non-catalog' });
      case 'invalid':
        // §18.7.6 / CWE-116/117 — the reason is display-sanitized at its source (the pointer read strips and
        // bounds the echoed rejected value), so the resolver forwards it as-is.
        return { load: { ok: false, error: pointer.reason } };
      case 'value': {
        const entry = deps.catalogEntry(pointer.id);
        if (entry.ok) {
          return {
            load: loadCatalogEntryDefinition(entry.flowDir),
            binding: { source: 'catalog', tier: entry.tier, id: pointer.id },
          };
        }
        return { load: { ok: false, error: catalogRefusal(pointer.id, entry.cause) } };
      }
      default:
        pointer satisfies never;
        return { load: { ok: false, error: 'the selected flow could not be read' } };
    }
  };
}

/** §18.7.6 refusal taxonomy. */
const CATALOG_REFUSAL_DETAIL: Record<CatalogRefusalCause, string> = {
  unknown: 'was not found in the catalog',
  escapes: 'resolves outside its catalog directory',
  unresolvable: 'could not be read',
};

/** §18.7.6 — every caller saw the entry on disk first, so one the resolver then finds absent reads as
 *  unreadable, never "not found". */
export function catalogRefusalReason(cause: CatalogRefusalCause): string {
  return CATALOG_REFUSAL_DETAIL[cause === 'unknown' ? 'unresolvable' : cause];
}

/** §18.7.6 */
export const UNSAFE_NAME_REASON = 'is not a valid flow id';

function catalogRefusal(id: string, cause: CatalogRefusalCause): string {
  return `Selected flow "${id}" ${CATALOG_REFUSAL_DETAIL[cause]}; pick another flow or use the default.`;
}

function loadCatalogEntryDefinition(flowDir: string): FlowLoad {
  return loadUntrustedFlowDefinition(path.join(flowDir, FLOW_DEF_FILE));
}

/** §18.7.3 */
export function resolveBoundSource(
  disposition: DispositionRead,
  catalogEntry: (id: string, tier?: CatalogTier) => CatalogResolution,
  localDir: string,
  globalDir: string,
): ResolvedRunDefinition {
  switch (disposition.source) {
    case 'catalog': {
      // §18.7.3 / CWE-841 — re-resolve the bound id within its exact stored tier; an entry absent there is the
      // §18.1 error state, never a silent swap to a different source.
      const entry = catalogEntry(disposition.id, disposition.tier);
      if (!entry.ok || entry.tier !== disposition.tier) return { load: lostBindingHold() };
      return { load: loadCatalogEntryDefinition(entry.flowDir), binding: disposition };
    }
    case 'non-catalog':
      return localFirst(localDir, globalDir, disposition);
    case 'fallback':
      return { load: loadFlowDefinition(globalDir), binding: disposition };
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
