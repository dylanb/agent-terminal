import { hasFlowDefinition } from './flow';
import { catalogTierJail, resolveCatalogEntry, type CatalogRoots } from './flowCatalog';
import { readDirEntries } from './dirEntries';
import { readActiveFlow } from './activeFlowPointer';
import { catalogRefusalReason } from './resolveRunDefinition';
import { isSafeCatalogId } from '../shared/pathSegment';
import { errMsg } from './errno';
import { displaySafeEcho, MAX_ECHOED_REASON_LENGTH } from '../shared/controlChars';
import { CATALOG_ORIGINS, type CatalogOrigin, type FlowCatalogEntry, type FlowCatalogListing, type FlowCatalogListResult } from '../shared/ipc';

interface TierMember {
  tier: CatalogOrigin;
  id: string;
  resolvesInTier: boolean;
}

function tierMembers(roots: CatalogRoots, tier: CatalogOrigin): TierMember[] {
  const jail = catalogTierJail(roots, tier);
  if (jail === null) return [];
  return readDirEntries(jail).flatMap(({ name }) => {
    if (!isSafeCatalogId(name)) return [];
    const res = resolveCatalogEntry(roots, name, tier);
    return res.ok || res.cause !== 'unknown' ? [{ tier, id: name, resolvesInTier: res.ok }] : [];
  });
}

export function listCatalog(roots: CatalogRoots): FlowCatalogListing {
  const members = CATALOG_ORIGINS.flatMap((tier) => tierMembers(roots, tier));
  const ids = [...new Set(members.map((m) => m.id))].sort((a, b) => a.localeCompare(b));

  const entries: FlowCatalogEntry[] = ids.map((id) => {
    // §18.7.6 / §18.7.3
    const verdict = resolveCatalogEntry(roots, id);
    if (verdict.ok) return { available: true, id, origin: verdict.tier };
    const origin = members.find((m) => m.id === id)!.tier;
    const reason = catalogRefusalReason(verdict.cause === 'unknown' ? 'unresolvable' : verdict.cause);
    return { available: false, label: id, origin, reason };
  });

  const resumable = members.filter((m) => m.resolvesInTier).map(({ tier, id }) => ({ origin: tier, id }));

  const pointer = readActiveFlow(roots.worktreeDir);
  return {
    entries,
    tierNotices: [],
    ...(pointer.kind === 'value' ? { selectedId: pointer.id } : {}),
    hasLocalFlow: hasFlowDefinition(roots.worktreeDir),
    hasGlobalFallback: hasFlowDefinition(roots.globalRoot),
    resumable,
  };
}

export function catalogListResult(list: () => FlowCatalogListing): FlowCatalogListResult {
  try {
    return { ok: true, listing: list() };
  } catch (e) {
    return { ok: false, reason: displaySafeEcho(`Could not list flows: ${errMsg(e)}`, MAX_ECHOED_REASON_LENGTH) };
  }
}
