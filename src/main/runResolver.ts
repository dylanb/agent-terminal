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
import { heldRunOf } from './runHoldRead';

/** §18.7.3 / §18.7.4 AC9 (CWE-841) */
export function createRunResolver(globalDir: string): (repoKey: string) => ResolvedRunDefinition {
  return (repoKey) =>
    createResolveRunDefinition({
      pointer: () => readActiveFlow(repoKey),
      catalogEntry: catalogEntryFor(repoKey, globalDir),
      runBinding: () => {
        const started = worktreeStartedness(repoKey);
        if (started !== 'started') return { started };
        const binding = readRunBinding(repoKey);
        if (binding !== null) return { started, disposition: binding };
        // §18.7.2 — a reset run's record that could not be removed binds nothing: no step is in progress to swap.
        return { started: heldRunOf(repoKey).hold === 'not-held' ? 'never-started' : 'indeterminate' };
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

/** §27.9.1 N9b.2(c) — a begun run's recorded binding re-resolved with its trust, through the same seams. */
export function createBoundSourceResolver(globalDir: string): (worktree: string, binding: DispositionRead) => ResolvedRunDefinition {
  return (worktree, binding) => resolveBoundSource(binding, catalogEntryFor(worktree, globalDir), worktree, globalDir);
}
