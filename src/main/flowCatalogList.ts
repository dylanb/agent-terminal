import type { FlowCatalogListing } from '../shared/ipc';
import type { CatalogRoots } from './flowCatalog';

export function listCatalog(_roots: CatalogRoots): FlowCatalogListing {
  return { entries: [], tierNotices: [], hasLocalFlow: false, hasGlobalFallback: false, resumable: [] };
}
