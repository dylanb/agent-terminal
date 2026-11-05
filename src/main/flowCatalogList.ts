import { hasFlowDefinition } from './flow';
import { catalogTierJail, resolveCatalogEntry, type CatalogRoots } from './flowCatalog';
import { readDirEntries, type DirEntry } from './dirEntries';
import { confinedRealPathResult, resolveJail } from './confinedPath';
import { readActiveFlow } from './activeFlowPointer';
import { catalogRefusalReason, UNSAFE_NAME_REASON } from './resolveRunDefinition';
import { isSafeCatalogId, MAX_CATALOG_ID_LENGTH } from '../shared/pathSegment';
import { errMsg } from './errno';
import { displaySafeEcho, MAX_ECHOED_REASON_LENGTH } from '../shared/controlChars';
import {
  CATALOG_ORIGINS,
  type CatalogOrigin,
  type FlowCatalogEntry,
  type FlowCatalogListing,
  type FlowCatalogListResult,
  type RebindChoice,
  type RecoveryOutcomeOf,
} from '../shared/ipc';

export const MAX_CATALOG_LIST_MEMBERS = 256;

interface TierMember {
  tier: CatalogOrigin;
  id: string;
  resolvesInTier: boolean;
}

type TierNotice = FlowCatalogListing['tierNotices'][number];

interface TierScan {
  members: TierMember[];
  unsafe: { tier: CatalogOrigin; name: string }[];
  notices: TierNotice[];
}

const TIER_DIR_NAME: Record<CatalogOrigin, string> = { repo: 'repo flows directory', global: 'global flows directory' };

const noticeOf = (tier: CatalogOrigin, text: string): TierNotice => ({
  origin: tier,
  notice: displaySafeEcho(text, MAX_ECHOED_REASON_LENGTH),
});

const unreadableNotice = (tier: CatalogOrigin, why: string): TierNotice => noticeOf(tier, `Could not read the ${TIER_DIR_NAME[tier]}: ${why}`);

const UNRESOLVED = 'its location does not resolve';

// CWE-22/59
function walkableTierDir(roots: CatalogRoots, tier: CatalogOrigin): { ok: true; dir: string } | { ok: false; notice: TierNotice } {
  const jail = catalogTierJail(roots, tier);
  const anchor = jail === null ? null : tier === 'repo' ? resolveJail(roots.worktreeDir) : jail;
  if (jail === null || anchor === null) return { ok: false, notice: unreadableNotice(tier, UNRESOLVED) };
  const confined = confinedRealPathResult(anchor, jail);
  if (!confined.ok) return { ok: false, notice: unreadableNotice(tier, confined.cause === 'escapes' ? 'it links outside its location' : UNRESOLVED) };
  return { ok: true, dir: confined.path };
}

// CWE-400/770
function scanTier(roots: CatalogRoots, tier: CatalogOrigin): TierScan {
  const scan: TierScan = { members: [], unsafe: [], notices: [] };
  const walkable = walkableTierDir(roots, tier);
  if (!walkable.ok) return { ...scan, notices: [walkable.notice] };
  let candidates: DirEntry[];
  try {
    candidates = readDirEntries(walkable.dir).filter((e) => !e.isFile);
  } catch (e) {
    return { ...scan, notices: [unreadableNotice(tier, errMsg(e))] };
  }
  if (candidates.length > MAX_CATALOG_LIST_MEMBERS) {
    scan.notices.push(noticeOf(tier, `The ${TIER_DIR_NAME[tier]} list was truncated to its first ${MAX_CATALOG_LIST_MEMBERS} members`));
  }
  for (const { name, isDirectory } of candidates.slice(0, MAX_CATALOG_LIST_MEMBERS)) {
    if (!isSafeCatalogId(name)) {
      if (isDirectory) scan.unsafe.push({ tier, name });
      continue;
    }
    const res = resolveCatalogEntry(roots, name, tier);
    if (res.ok || res.cause !== 'unknown') scan.members.push({ tier, id: name, resolvesInTier: res.ok });
  }
  return scan;
}

// Quoted so no label can equal a safe id, which the picker keys its rows by (flowPicker.ts `Row.key`).
const unsafeNameLabel = (name: string): string => `"${displaySafeEcho(name, MAX_CATALOG_ID_LENGTH)}"`;

export function listCatalog(
  roots: CatalogRoots,
  recoveryOutcomes: (choices: RebindChoice[]) => RecoveryOutcomeOf[] = () => [],
): FlowCatalogListing {
  const scans = CATALOG_ORIGINS.map((tier) => scanTier(roots, tier));
  const members = scans.flatMap((s) => s.members);
  const ids = [...new Set(members.map((m) => m.id))].sort((a, b) => a.localeCompare(b));

  const entries: FlowCatalogEntry[] = ids.map((id) => {
    // §18.7.6 / §18.7.3
    const verdict = resolveCatalogEntry(roots, id);
    if (verdict.ok) return { available: true, id, origin: verdict.tier };
    const origin = members.find((m) => m.id === id)!.tier;
    const reason = catalogRefusalReason(verdict.cause);
    return { available: false, label: id, origin, reason };
  });
  const unsafeNames = new Set<string>();
  for (const { tier, name } of scans.flatMap((s) => s.unsafe)) {
    if (unsafeNames.has(name)) continue;
    unsafeNames.add(name);
    entries.push({ available: false, label: unsafeNameLabel(name), origin: tier, reason: UNSAFE_NAME_REASON });
  }

  const choices: RebindChoice[] = [
    ...(hasFlowDefinition(roots.worktreeDir) ? [{ origin: 'local' } as const] : []),
    ...members.filter((m) => m.resolvesInTier).map(({ tier, id }) => ({ origin: tier, id })),
    ...(hasFlowDefinition(roots.globalRoot) ? [{ origin: 'fallback' } as const] : []),
  ];

  const pointer = readActiveFlow(roots.worktreeDir);
  return {
    entries,
    tierNotices: scans.flatMap((s) => s.notices),
    selection: pointer.kind === 'value' ? { kind: 'value', id: pointer.id } : { kind: pointer.kind },
    recoveryOutcomes: recoveryOutcomes(choices),
  };
}

export function catalogListResult(list: () => FlowCatalogListing): FlowCatalogListResult {
  try {
    return { ok: true, listing: list() };
  } catch (e) {
    return { ok: false, reason: displaySafeEcho(`Could not list flows: ${errMsg(e)}`, MAX_ECHOED_REASON_LENGTH) };
  }
}
