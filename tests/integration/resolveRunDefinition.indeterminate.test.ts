import { describe, it, expect, afterEach } from 'vitest';
import {
  createResolveRunDefinition,
  type PointerRead,
  type CatalogResolution,
} from '../../src/main/resolveRunDefinition';
import { type FlowLoad } from '../../src/main/flow';
import { createWorktreeFixture } from '../helpers/worktreeFixture';
import { createCatalogFixture } from '../helpers/catalogFixture';

// A2 (#133) impl-slice 3 — AC7 third fail-closed consumer (§18.7.4 / CWE-841). The started-ness signal has
// three consumers: the pointer-write gate and A3's picker-enable classify it via isSelectionLocked, and
// definition resolution — pinned here — classifies the raw signal directly. When started-ness is
// 'indeterminate' (an I/O/YAML/schema-invalid/over-cap/confinement-escape progression whose begun-ness cannot
// be trusted), the resolver must HOLD at the §18.1 error state and MUST NOT run the three-leg re-evaluation —
// re-reading the pointer there would swap a corrupt run's source out from under it. The pin sets the pointer to
// a VALID, DISTINCT catalog flow: a resolver that (wrongly) re-read the pointer would return that flow instead
// of the error, so the swap is observable. The started-ness SEAM is the injected domain concept the resolver
// needs (CLAUDE.md injection-seam rule), never an fs primitive.

describe('resolveRunDefinition — refuses on indeterminate started-ness (§18.7.4 AC7)', () => {
  const fx = createWorktreeFixture();
  const catalog = createCatalogFixture();
  afterEach(() => {
    fx.cleanup();
    catalog.cleanup();
  });

  const seedGlobalFallback = (): string => {
    const globalRoot = fx.makeWorktree('global');
    fx.writeFlowHome(globalRoot, { name: 'global-flow', stepIds: ['global-step'] });
    return globalRoot;
  };

  const seedCatalogEntry = (id: string): CatalogResolution => {
    const catalogDir = catalog.makeCatalogDir();
    const flowDir = catalog.addEntry(catalogDir, id);
    return { ok: true, tier: 'repo', flowDir };
  };

  it('AC7: indeterminate started-ness holds at the §18.1 error, never re-reading the pointer to swap source', () => {
    const wt = fx.makeWorktree('indeterminate'); // .agent-terminal/ exists, but NO local flow.yaml
    const globalRoot = seedGlobalFallback();
    const entry = seedCatalogEntry('catalog-flow');

    // A VALID, DISTINCT catalog flow: were the resolver to (wrongly) run the three legs it would resolve this
    // and return load.ok === true; the fail-closed contract is the §18.1 error hold instead.
    const pointer: () => PointerRead = () => ({ kind: 'value', id: 'catalog-flow' });
    const catalogEntry = (id: string): CatalogResolution =>
      id === 'catalog-flow' ? entry : { ok: false, cause: 'unknown' };
    const startedness = (): 'never-started' | 'started' | 'indeterminate' => 'indeterminate';

    const resolve = createResolveRunDefinition({ pointer, catalogEntry, startedness });
    const result = resolve(wt, globalRoot);

    const load: FlowLoad = result.load;
    expect(load.ok).toBe(false); // §18.1 error hold — NOT the pointer's 'catalog-flow', NOT the fallback
  });
});
