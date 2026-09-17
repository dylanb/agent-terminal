import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  createResolveRunDefinition,
  type PointerRead,
  type CatalogResolution,
} from '../../src/main/resolveRunDefinition';
import { FLOW_DEF_FILE, type FlowLoad } from '../../src/main/flow';
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
    expect(result.selectionReason).toBeUndefined(); // a resolved selection is not a degrade — no reason surfaced
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
    expect(result.selectionReason).toBeUndefined(); // a resolved local flow is not a degrade — no reason surfaced
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

  it('a value pointer whose catalog entry is unresolvable falls to the global fallback (leg 2 miss → leg 3)', () => {
    const wt = fx.makeWorktree('leg2-miss'); // no local flow.yaml
    const globalRoot = seedGlobalFallback();

    // A set pointer naming an id the catalog cannot resolve — the resolve-to-fallback half of the bad-pointer AC
    // this slice implements (the visible degrade reason is a later slice); the value branch must NOT crash or
    // return an error load, it must fall through to the fallback.
    const pointer: () => PointerRead = () => ({ kind: 'value', id: 'ghost' });
    const catalogEntry = (): CatalogResolution => ({ ok: false, cause: 'unknown' });

    const resolve = createResolveRunDefinition({ pointer, catalogEntry });
    const result = resolve(wt, globalRoot);

    expect(definitionName(result.load)).toBe('global-flow'); // unresolvable value → fallback, never a throw
  });

  it('leg 1 gates on presence, not validity: a present-but-invalid local surfaces its own error, not a resolvable pointer or the fallback', () => {
    const wt = fx.makeWorktree('leg1-invalid');
    fx.writeFlowHome(wt, { name: 'local-broken', stepIds: [] }); // present but §18.1-invalid (no steps)
    const globalRoot = seedGlobalFallback();
    const entry = seedCatalogEntry('catalog-flow');

    const pointer: () => PointerRead = () => ({ kind: 'value', id: 'catalog-flow' }); // resolvable + distinct
    const catalogEntry = (id: string): CatalogResolution =>
      id === 'catalog-flow' ? entry : { ok: false, cause: 'unknown' };

    const resolve = createResolveRunDefinition({ pointer, catalogEntry });
    const result = resolve(wt, globalRoot);

    // A refactor to `if (loadFlowDefinitionLocalFirst(...).ok)` would let this fall through to the resolvable
    // pointer (or fallback), turning the load ok — the presence-not-validity guard is what keeps it an error.
    expect(result.load.ok).toBe(false);
  });

  it('a resolvable catalog entry whose flow.yaml is §18.1-invalid surfaces its own error, never a degrade to the fallback', () => {
    const wt = fx.makeWorktree('leg2-invalid'); // no local flow.yaml
    const globalRoot = seedGlobalFallback();

    // A resolvable leg-2 entry whose flow.yaml is present but §18.1-invalid (no steps): overwrite the valid
    // default addEntry seeds. The ticket rules this outcome in scope for the resolver — "Schema-invalid
    // definition content is the §18.1 error state, not a degrade" — so the resolver must return THIS entry's
    // own error, never fall through to the global fallback. A mutation degrading it would make load.ok true
    // (the fallback's 'global-flow'); the leg2-miss test above covers the distinct unresolvable→fallback case.
    const catalogDir = catalog.makeCatalogDir();
    const flowDir = catalog.addEntry(catalogDir, 'catalog-broken');
    writeFileSync(path.join(flowDir, FLOW_DEF_FILE), 'name: catalog-broken\nsteps: []\n');

    const pointer: () => PointerRead = () => ({ kind: 'value', id: 'catalog-broken' });
    const catalogEntry = (id: string): CatalogResolution =>
      id === 'catalog-broken' ? { ok: true, tier: 'repo', flowDir } : { ok: false, cause: 'unknown' };

    const resolve = createResolveRunDefinition({ pointer, catalogEntry });
    const result = resolve(wt, globalRoot);

    expect(result.load.ok).toBe(false);
  });
});
