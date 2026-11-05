import { REPO_SETUP_FLOW_ID } from '../shared/setupCheck';
import { resolveCatalogEntry, type CatalogRoots } from './flowCatalog';

/** Whether Run setup loop may start the shipped repo-setup flow for the repository at `roots.worktreeDir`. */
export function repoSetupFlowInstalled(roots: CatalogRoots): boolean {
  return resolveCatalogEntry(roots, REPO_SETUP_FLOW_ID, 'global').ok;
}
