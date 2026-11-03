import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  createResolveRunDefinition,
  type PointerRead,
  type CatalogResolution,
} from '../../src/main/resolveRunDefinition';
import type { FlowLoad } from '../../src/main/flow';
import { createWorktreeFixture } from '../helpers/worktreeFixture';
import { createCatalogFixture } from '../helpers/catalogFixture';
import { FLOW_DEF_FILE } from '../../src/main/flowHome';

// §18.7.3 — the ordered definition sources: the catalog entry the active-flow pointer names, else (pointer unset)
// a present local flow.yaml, else the global fallback. The observable
// behavior is WHICH FlowLoad.definition the resolver returns for each precedence case (AC1/AC2/AC3), read over
// REAL on-disk flow.yaml fixtures. The pointer and catalog-entry SEAMS are injected fakes (CLAUDE.md
// injection-seam rule), so this pins the precedence the resolver composes while the seams' real
// implementations (activeFlowPointer / flowCatalog) are covered by their own fixtures.

describe('resolveRunDefinition — flow-definition precedence (§18.7.3)', () => {
  const fx = createWorktreeFixture();
  const catalog = createCatalogFixture();
  afterEach(() => {
    fx.cleanup();
    catalog.cleanup();
  });

  // The global fallback root: the resolver reads <globalRoot>/.agent-terminal/flow.yaml.
  const seedGlobalFallback = (): string => {
    const globalRoot = fx.makeWorktree('global');
    fx.writeFlowHome(globalRoot, { name: 'global-flow', stepIds: ['global-step'] });
    return globalRoot;
  };

  // A resolvable catalog entry: addEntry writes <catalogDir>/<id>/flow.yaml whose name === id.
  const seedCatalogEntry = (id: string): CatalogResolution => {
    const catalogDir = catalog.makeCatalogDir();
    const flowDir = catalog.addEntry(catalogDir, id);
    return { ok: true, tier: 'repo', flowDir };
  };

  const definitionName = (load: FlowLoad): string => {
    if (!load.ok) throw new Error(`expected a resolved definition, got error: ${load.error}`);
    return load.definition.name;
  };

  it('AC1: a set pointer resolves the pointer-named catalog flow', () => {
    const wt = fx.makeWorktree('ac1'); // .agent-terminal/ exists, but NO local flow.yaml
    const globalRoot = seedGlobalFallback();
    const entry = seedCatalogEntry('catalog-flow');

    const pointer: () => PointerRead = () => ({ kind: 'value', id: 'catalog-flow' });
    const catalogEntry = (id: string): CatalogResolution =>
      id === 'catalog-flow' ? entry : { ok: false, cause: 'unknown' };

    const resolve = createResolveRunDefinition({ pointer, catalogEntry });
    const result = resolve(wt, globalRoot);

    expect(definitionName(result.load)).toBe('catalog-flow');
  });

  it("AC2: the operator's pick wins over a present local flow.yaml", () => {
    const wt = fx.makeWorktree('ac2');
    fx.writeFlowHome(wt, { name: 'local-flow', stepIds: ['local-step'] });
    const globalRoot = seedGlobalFallback();
    const entry = seedCatalogEntry('catalog-flow');

    const pointer: () => PointerRead = () => ({ kind: 'value', id: 'catalog-flow' });
    const catalogEntry = (id: string): CatalogResolution =>
      id === 'catalog-flow' ? entry : { ok: false, cause: 'unknown' };

    const resolve = createResolveRunDefinition({ pointer, catalogEntry });
    const result = resolve(wt, globalRoot);

    expect(definitionName(result.load)).toBe('catalog-flow');
  });

  it('AC3: an unset pointer with no local flow.yaml runs the global fallback', () => {
    const wt = fx.makeWorktree('ac3'); // no local flow.yaml
    const globalRoot = seedGlobalFallback();

    const pointer: () => PointerRead = () => ({ kind: 'unset' });
    const catalogEntry = (): CatalogResolution => ({ ok: false, cause: 'unknown' });

    const resolve = createResolveRunDefinition({ pointer, catalogEntry });
    const result = resolve(wt, globalRoot);

    expect(definitionName(result.load)).toBe('global-flow');
  });

  it('an unset pointer with a present local flow.yaml runs the local flow (the default)', () => {
    const wt = fx.makeWorktree('unset-local');
    fx.writeFlowHome(wt, { name: 'local-flow', stepIds: ['local-step'] });
    const globalRoot = seedGlobalFallback();

    const pointer: () => PointerRead = () => ({ kind: 'unset' });
    const catalogEntry = (): CatalogResolution => ({ ok: false, cause: 'unknown' });

    const result = createResolveRunDefinition({ pointer, catalogEntry })(wt, globalRoot);

    expect(definitionName(result.load)).toBe('local-flow');
  });

  it('a value pointer whose catalog entry is unresolvable refuses to run rather than falling to the local flow or the global fallback', () => {
    const wt = fx.makeWorktree('pick-miss');
    fx.writeFlowHome(wt, { name: 'local-flow', stepIds: ['local-step'] });
    const globalRoot = seedGlobalFallback();

    const pointer: () => PointerRead = () => ({ kind: 'value', id: 'ghost' });
    const catalogEntry = (): CatalogResolution => ({ ok: false, cause: 'unknown' });

    const result = createResolveRunDefinition({ pointer, catalogEntry })(wt, globalRoot);

    expect(result.load.ok).toBe(false);
  });

  it('with the pointer unset, a present-but-invalid local flow.yaml surfaces its own error, not the global fallback', () => {
    const wt = fx.makeWorktree('local-invalid');
    fx.writeFlowHome(wt, { name: 'local-broken', stepIds: [] }); // present but §18.1-invalid (no steps)
    const globalRoot = seedGlobalFallback();

    const pointer: () => PointerRead = () => ({ kind: 'unset' });
    const catalogEntry = (): CatalogResolution => ({ ok: false, cause: 'unknown' });

    const result = createResolveRunDefinition({ pointer, catalogEntry })(wt, globalRoot);

    expect(result.load.ok).toBe(false);
  });

  it('a resolvable catalog entry whose flow.yaml is §18.1-invalid surfaces its own error, not the global fallback', () => {
    const wt = fx.makeWorktree('pick-invalid'); // no local flow.yaml
    const globalRoot = seedGlobalFallback();

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
