import { describe, it, expect, afterEach } from 'vitest';
import {
  createResolveRunDefinition,
  type PointerRead,
  type CatalogResolution,
} from '../../src/main/resolveRunDefinition';
import { type FlowLoad } from '../../src/main/flow';
import { createWorktreeFixture } from '../helpers/worktreeFixture';
import { createCatalogFixture } from '../helpers/catalogFixture';

// A2 (#133) impl-slice 1 — the three ordered definition sources (§18.7.3): a present local flow.yaml (leg 1,
// back-compat) → the catalog entry the pointer names (leg 2) → the global fallback (leg 3). The observable
// behavior is WHICH FlowLoad.definition the resolver returns for each precedence case (AC1/AC2/AC3), read over
// REAL on-disk flow.yaml fixtures. The pointer and catalog-entry SEAMS are injected fakes (CLAUDE.md
// injection-seam rule), so this pins the precedence the resolver composes while the seams' real
// implementations (activeFlowPointer / flowCatalog) are covered by their own fixtures.

describe('resolveRunDefinition — three-leg flow-definition resolution (§18.7.3)', () => {
  const fx = createWorktreeFixture();
  const catalog = createCatalogFixture();
  afterEach(() => {
    fx.cleanup();
    catalog.cleanup();
  });

  // The global fallback root (leg 3): the resolver reads <globalRoot>/.agent-terminal/flow.yaml.
  const seedGlobalFallback = (): string => {
    const globalRoot = fx.makeWorktree('global');
    fx.writeFlowHome(globalRoot, { name: 'global-flow', stepIds: ['global-step'] });
    return globalRoot;
  };

  // A resolvable catalog entry (leg 2): addEntry writes <catalogDir>/<id>/flow.yaml whose name === id.
  const seedCatalogEntry = (id: string): CatalogResolution => {
    const catalogDir = catalog.makeCatalogDir();
    const flowDir = catalog.addEntry(catalogDir, id);
    return { ok: true, tier: 'repo', flowDir };
  };

  const definitionName = (load: FlowLoad): string => {
    if (!load.ok) throw new Error(`expected a resolved definition, got error: ${load.error}`);
    return load.definition.name;
  };

  it('AC1: a set pointer with no local flow.yaml resolves the pointer-named catalog flow (leg 2)', () => {
    const wt = fx.makeWorktree('ac1'); // .agent-terminal/ exists, but NO local flow.yaml
    const globalRoot = seedGlobalFallback();
    const entry = seedCatalogEntry('catalog-flow');

    const pointer: () => PointerRead = () => ({ kind: 'value', id: 'catalog-flow' });
    const catalogEntry = (id: string): CatalogResolution =>
      id === 'catalog-flow' ? entry : { ok: false, cause: 'unknown' };

    const resolve = createResolveRunDefinition({ pointer, catalogEntry });
    const result = resolve(wt, globalRoot);

    expect(definitionName(result.load)).toBe('catalog-flow'); // the pointer's catalog flow, NOT the fallback
  });

  it('AC2: a present local flow.yaml wins regardless of a resolvable pointer (leg 1 precedence)', () => {
    const wt = fx.makeWorktree('ac2');
    fx.writeFlowHome(wt, { name: 'local-flow', stepIds: ['local-step'] });
    const globalRoot = seedGlobalFallback();
    const entry = seedCatalogEntry('catalog-flow');

    const pointer: () => PointerRead = () => ({ kind: 'value', id: 'catalog-flow' }); // resolvable + distinct
    const catalogEntry = (id: string): CatalogResolution =>
      id === 'catalog-flow' ? entry : { ok: false, cause: 'unknown' };

    const resolve = createResolveRunDefinition({ pointer, catalogEntry });
    const result = resolve(wt, globalRoot);

    expect(definitionName(result.load)).toBe('local-flow'); // leg 1 beats a resolvable leg-2 pointer
  });

  it('AC3: an unset pointer with no local falls to the silent global fallback (leg 3, no reason)', () => {
    const wt = fx.makeWorktree('ac3'); // no local flow.yaml
    const globalRoot = seedGlobalFallback();

    const pointer: () => PointerRead = () => ({ kind: 'unset' });
    const catalogEntry = (): CatalogResolution => ({ ok: false, cause: 'unknown' });

    const resolve = createResolveRunDefinition({ pointer, catalogEntry });
    const result = resolve(wt, globalRoot);

    expect(definitionName(result.load)).toBe('global-flow');
    expect(result.selectionReason).toBeUndefined(); // unset is the normal default, never a degrade (AC3)
  });
});
