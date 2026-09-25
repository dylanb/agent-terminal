import { hasFlowDefinition } from './flow';
import { catalogTierJail, resolveCatalogEntry, type CatalogRoots } from './flowCatalog';
import { readDirEntries } from './dirEntries';
import { readActiveFlow } from './activeFlowPointer';
import { catalogRefusalReason } from './resolveRunDefinition';
import { isSafeCatalogId } from '../shared/pathSegment';
import { errMsg } from './errno';
import { displaySafeEcho, MAX_ECHOED_REASON_LENGTH } from '../shared/controlChars';
import type { CatalogOrigin, FlowCatalogEntry, FlowCatalogListing, FlowCatalogListResult } from '../shared/ipc';

const TIERS: readonly CatalogOrigin[] = ['repo', 'global'];

function tierMembers(roots: CatalogRoots, tier: CatalogOrigin): string[] {
  const jail = catalogTierJail(roots, tier);
  if (jail === null) return [];
  return readDirEntries(jail)
    .map((e) => e.name)
    .filter((name) => {
      if (!isSafeCatalogId(name)) return false;
      const res = resolveCatalogEntry(roots, name, tier);
      return res.ok || res.cause !== 'unknown';
    });
}

export function listCatalog(roots: CatalogRoots): FlowCatalogListing {
  const membersByTier = new Map(TIERS.map((tier) => [tier, tierMembers(roots, tier)] as const));
  const ids = [...new Set(TIERS.flatMap((tier) => membersByTier.get(tier)!))].sort((a, b) => a.localeCompare(b));

  const entries: FlowCatalogEntry[] = ids.map((id) => {
    // §18.7.6 / §18.7.3 leg 2
    const verdict = resolveCatalogEntry(roots, id);
    if (verdict.ok) return { available: true, id, origin: verdict.tier };
    const origin = TIERS.find((tier) => membersByTier.get(tier)!.includes(id))!;
    const reason = verdict.cause === 'unknown' ? catalogRefusalReason('unresolvable') : catalogRefusalReason(verdict.cause);
    return { available: false, label: id, origin, reason };
  });

  const resumable = TIERS.flatMap((tier) =>
    membersByTier.get(tier)!.filter((id) => resolveCatalogEntry(roots, id, tier).ok).map((id) => ({ origin: tier, id })),
  );

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
