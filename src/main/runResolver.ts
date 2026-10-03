// A2 (#133) §18.7.3 — the per-worktree run-definition resolver wired with its real production seams: the
// active-flow pointer (leg 2), the per-tier catalog resolver, and the run-scoped binding a begun run
// re-resolves instead of the live pointer (§18.7.3 AC9 / CWE-841). One factory both index.ts and the
// integration tests drive, so the tests exercise the production wiring, not a parallel copy of it.
import { createResolveRunDefinition, type ResolvedRunDefinition } from './resolveRunDefinition';
import { readActiveFlow } from './activeFlowPointer';
import { resolveCatalogEntry } from './flowCatalog';
import { worktreeStartedness } from './startedness';
import { readRunBinding } from './runDisposition';

/** The authoritative resolver: leg 1 local flow.yaml → leg 2 the pointer's catalog entry (repo tier, then
 *  global) → leg 3 the global fallback, with a display-sanitized degrade reason when leg 2 fails. A BEGUN run
 *  resolves its recorded source binding, never the live pointer; a begun run whose binding cannot be read fails
 *  closed to the §18.1 error rather than a live re-resolution (§18.7.3/§18.7.4 AC9, CWE-841). */
export function createRunResolver(globalDir: string): (repoKey: string) => ResolvedRunDefinition {
  return (repoKey) =>
    createResolveRunDefinition({
      pointer: () => readActiveFlow(repoKey),
      catalogEntry: (id, tier) => resolveCatalogEntry({ worktreeDir: repoKey, globalRoot: globalDir }, id, tier),
      runBinding: () => {
        const started = worktreeStartedness(repoKey);
        if (started !== 'started') return { started };
        const binding = readRunBinding(repoKey);
        return binding === null ? { started: 'indeterminate' } : { started, disposition: binding };
      },
    })(repoKey, globalDir);
}
