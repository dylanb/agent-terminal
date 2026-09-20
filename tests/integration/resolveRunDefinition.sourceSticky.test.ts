import { describe, it, expect, afterEach } from 'vitest';
import {
  createResolveRunDefinition,
  type PointerRead,
  type CatalogResolution,
  type RunBinding,
} from '../../src/main/resolveRunDefinition';
import { type FlowLoad } from '../../src/main/flow';
import { createWorktreeFixture } from '../helpers/worktreeFixture';
import { createCatalogFixture } from '../helpers/catalogFixture';

// A2 (#133) impl-slice 4 — AC9 begun-run source binding, sticky across restart (§18.7.3 / CWE-841). Once a run
// has begun, its definition source is FIXED to the disposition (`DispositionRead`) the resolver recorded at
// flow:start — a
// catalog run re-resolves its bound tier+id, a non-catalog run keeps the live local↔global chain — and the
// resolver NEVER re-reads the pointer to re-derive the source (a mid-run pointer change must have no effect, the
// silent source-swap AC9 forbids). The observable behavior is WHICH FlowLoad.definition a 'started' run resolves
// when the current pointer names a DIFFERENT flow than the one the run was begun on. The disposition SEAM is the
// injected domain concept the resolver needs (CLAUDE.md injection-seam rule); its content is asserted through the
// resolved definition, never a pointer() call-count spy.

describe('resolveRunDefinition — a begun run resolves its recorded source, never the pointer (§18.7.3 AC9)', () => {
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

  const definitionName = (load: FlowLoad): string => {
    if (!load.ok) throw new Error(`expected a resolved definition, got error: ${load.error}`);
    return load.definition.name;
  };

  it('AC9: a begun CATALOG run re-resolves its RECORDED disposition source, never the current pointer', () => {
    const wt = fx.makeWorktree('begun-catalog'); // .agent-terminal/ exists, but NO local flow.yaml
    const globalRoot = seedGlobalFallback();

    // Two DISTINCT catalog flows: the run was begun bound to `bound-flow`; the pointer now names a DIFFERENT
    // flow `pointer-flow`. A source-sticky resolver returns `bound-flow`; a resolver that re-read the pointer
    // (the CWE-841 mid-run swap AC9 forbids) would return `pointer-flow`.
    const boundDir = catalog.addEntry(catalog.makeCatalogDir(), 'bound-flow');
    const pointerDir = catalog.addEntry(catalog.makeCatalogDir(), 'pointer-flow');

    const pointer: () => PointerRead = () => ({ kind: 'value', id: 'pointer-flow' });
    const catalogEntry = (id: string): CatalogResolution => {
      if (id === 'bound-flow') return { ok: true, tier: 'repo', flowDir: boundDir };
      if (id === 'pointer-flow') return { ok: true, tier: 'repo', flowDir: pointerDir };
      return { ok: false, cause: 'unknown' };
    };
    // The run-binding SEAM (its content is the run-scoped source binding): this run was begun on the repo
    // catalog entry `bound-flow`.
    const runBinding = (): RunBinding => ({
      started: 'started',
      disposition: { source: 'catalog', tier: 'repo', id: 'bound-flow' },
    });

    const resolve = createResolveRunDefinition({ pointer, catalogEntry, runBinding });
    const result = resolve(wt, globalRoot);

    // The recorded source, NOT the pointer's `pointer-flow`: a begun catalog run is source-sticky across a
    // restart and never silently swaps to a later-set pointer (§18.7.3, CWE-841).
    expect(definitionName(result.load)).toBe('bound-flow');
  });

  it('AC9: a begun NON-CATALOG run keeps its live local↔global chain and never consults the pointer', () => {
    const wt = fx.makeWorktree('begun-non-catalog'); // no local flow.yaml → the non-catalog source is the global fallback
    const globalRoot = seedGlobalFallback();

    // The run was begun on a NON-catalog source; the pointer now names a VALID, DISTINCT catalog flow. A
    // resolver that consults the pointer mid-run would swap to `catalog-flow`; AC9 requires the pointer value to
    // have NO effect on a begun non-catalog run — it resolves the unchanged non-catalog source (`global-flow`).
    const catalogDir = catalog.addEntry(catalog.makeCatalogDir(), 'catalog-flow');
    const pointer: () => PointerRead = () => ({ kind: 'value', id: 'catalog-flow' });
    const catalogEntry = (id: string): CatalogResolution =>
      id === 'catalog-flow' ? { ok: true, tier: 'repo', flowDir: catalogDir } : { ok: false, cause: 'unknown' };
    const runBinding = (): RunBinding => ({ started: 'started', disposition: { source: 'non-catalog' } });

    const resolve = createResolveRunDefinition({ pointer, catalogEntry, runBinding });
    const result = resolve(wt, globalRoot);

    // The unchanged non-catalog source, NOT the pointer's `catalog-flow`: a begun non-catalog run never reads
    // the pointer for the rest of its life (§18.7.3, CWE-841).
    expect(definitionName(result.load)).toBe('global-flow');
  });

  it('AC9: a begun CATALOG run never swaps to a same-named entry that now wins in a DIFFERENT tier', () => {
    const wt = fx.makeWorktree('begun-catalog-tier'); // .agent-terminal/ exists, NO local flow.yaml
    const globalRoot = seedGlobalFallback();

    // Begun bound to id `shadow-flow` in the GLOBAL tier; on restart the merged catalog resolves that id to a
    // REPO-tier entry (repo wins the §18.1 name clash). AC9 forbids a silent tier swap: the bound source is no
    // longer in the tier it was bound to, so resolution surfaces the §18.1 error — it never opens the repo entry.
    const repoShadow = catalog.addEntry(catalog.makeCatalogDir(), 'shadow-flow');
    const pointer: () => PointerRead = () => ({ kind: 'value', id: 'shadow-flow' });
    const catalogEntry = (id: string): CatalogResolution =>
      id === 'shadow-flow' ? { ok: true, tier: 'repo', flowDir: repoShadow } : { ok: false, cause: 'unknown' };
    const runBinding = (): RunBinding => ({
      started: 'started',
      disposition: { source: 'catalog', tier: 'global', id: 'shadow-flow' },
    });

    const resolve = createResolveRunDefinition({ pointer, catalogEntry, runBinding });
    const result = resolve(wt, globalRoot);

    expect(result.load.ok).toBe(false);
  });

  it('AC9: a begun CATALOG run whose bound entry is gone surfaces the §18.1 error, never the fallback', () => {
    const wt = fx.makeWorktree('begun-catalog-lost'); // .agent-terminal/ exists, NO local flow.yaml
    const globalRoot = seedGlobalFallback();

    // The bound catalog entry no longer resolves. AC9: loss of the bound source is the §18.1 error state — never
    // a silent live swap to the local↔global fallback (`global-flow` here).
    const pointer: () => PointerRead = () => ({ kind: 'value', id: 'whatever' });
    const catalogEntry = (_id: string): CatalogResolution => ({ ok: false, cause: 'unknown' });
    const runBinding = (): RunBinding => ({
      started: 'started',
      disposition: { source: 'catalog', tier: 'repo', id: 'gone' },
    });

    const resolve = createResolveRunDefinition({ pointer, catalogEntry, runBinding });
    const result = resolve(wt, globalRoot);

    expect(result.load.ok).toBe(false);
  });

  // §18.7.3 / CWE-841 seam robustness (CLAUDE.md injection-seam / BundleLocation discriminated-union rule): a
  // begun run is ALWAYS source-sticky, so the run-binding seam must make "started without a disposition"
  // unrepresentable. Were it a flat record of independently-optional started-ness + disposition, a consumer
  // could wire started-ness alone and silently fall through to a live pointer re-read (the mid-run source-swap
  // AC9 forbids), with neither the compiler nor any test to catch it. The @ts-expect-error below is the
  // load-bearing assertion: if the illegal shape ever type-checks, it becomes an unused directive and `tsc`
  // fails the build. tsconfig.node.json compiles tests/integration, so this is enforced by `pnpm run build`.
  it("the run-binding seam makes a begun run without a disposition a compile error (unrepresentable)", () => {
    // @ts-expect-error a 'started' run-binding must carry the `disposition` it is bound to.
    const illegal: RunBinding = { started: 'started' };
    const bound: RunBinding = { started: 'started', disposition: { source: 'non-catalog' } };
    expect(illegal.started).toBe('started');
    expect(bound.started).toBe('started');
  });
});
