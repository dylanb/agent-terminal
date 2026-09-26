// A2 (#133) §18.7.3 — the per-worktree run-definition resolver wired with its real production seams: the
// active-flow pointer, the per-tier catalog resolver, and the run-scoped binding a begun run
// re-resolves instead of the live pointer (§18.7.3 AC9 / CWE-841). One factory both index.ts and the
// integration tests drive, so the tests exercise the production wiring, not a parallel copy of it.
import {
  createResolveRunDefinition,
  resolveBoundSource,
  type CatalogResolution,
  type CatalogTier,
  type DispositionRead,
  type ResolvedRunDefinition,
} from './resolveRunDefinition';
import type { FlowLoad } from './flow';
import { readActiveFlow } from './activeFlowPointer';
import { resolveCatalogEntry } from './flowCatalog';
import { worktreeStartedness } from './startedness';
import { readRunBinding } from './runDisposition';

/** The authoritative resolver: the pointer's catalog entry (repo tier, then global) when a pick is set — an
 *  unusable pick is the §18.1 error with a display-sanitized reason — else the local flow.yaml, else the global
 *  fallback. A BEGUN run resolves its recorded source binding, never the live pointer; a begun run whose binding
 *  cannot be read fails closed to the §18.1 error rather than a live re-resolution (§18.7.3/§18.7.4 AC9, CWE-841). */
export function createRunResolver(globalDir: string): (repoKey: string) => ResolvedRunDefinition {
  return (repoKey) =>
    createResolveRunDefinition({
      pointer: () => readActiveFlow(repoKey),
      catalogEntry: catalogEntryFor(repoKey, globalDir),
      runBinding: () => {
        const started = worktreeStartedness(repoKey);
        if (started !== 'started') return { started };
        const binding = readRunBinding(repoKey);
        return binding === null ? { started: 'indeterminate' } : { started, disposition: binding };
      },
    })(repoKey, globalDir);
}

const catalogEntryFor =
  (worktreeDir: string, globalDir: string) =>
  (id: string, tier?: CatalogTier): CatalogResolution =>
    resolveCatalogEntry({ worktreeDir, globalRoot: globalDir }, id, tier);

/** §18.7.3 — the definition a recorded binding loads, through the same seams the begun-run leg of
 *  createRunResolver uses, so a rebind's load and the next flow.state load cannot disagree. */
export function createBoundSourceLoader(globalDir: string): (worktree: string, binding: DispositionRead) => FlowLoad {
  return (worktree, binding) => resolveBoundSource(binding, catalogEntryFor(worktree, globalDir), worktree, globalDir).load;
}
