import { describe, it, expect, afterEach } from 'vitest';
import {
  createResolveRunDefinition,
  type PointerRead,
  type CatalogResolution,
  type RunBinding,
} from '../../src/main/resolveRunDefinition';
import type { FlowLoad } from '../../src/main/flow';
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
    const runBinding = (): RunBinding => ({ started: 'indeterminate' });

    const resolve = createResolveRunDefinition({ pointer, catalogEntry, runBinding });
    const result = resolve(wt, globalRoot);

    const load: FlowLoad = result.load;
    expect(load.ok).toBe(false); // §18.1 error hold — NOT the pointer's 'catalog-flow', NOT the fallback
  });

  it('AC7: indeterminate started-ness holds even when a local flow.yaml is present — the hold precedes the local leg', () => {
    const wt = fx.makeWorktree('indeterminate-local');
    fx.writeFlowHome(wt, { name: 'local-flow', stepIds: ['local-step'] }); // a PRESENT local flow.yaml (leg 2)
    const globalRoot = seedGlobalFallback();

    // The fail-closed hold must precede the local leg, not only the pointer read: an unverifiable progression may be a
    // begun CATALOG run whose local flow.yaml was added mid-run, so letting the local leg win here would swap that
    // begun run's source to the local flow (CWE-841). Indeterminate begun-ness cannot tell the two apart, so a
    // present local flow does NOT win — resolution holds at the §18.1 error. A guard reordered below the local
    // presence check would run 'local-flow' (load.ok === true) and fail this pin.
    const pointer: () => PointerRead = () => ({ kind: 'unset' });
    const catalogEntry = (): CatalogResolution => ({ ok: false, cause: 'unknown' });
    const runBinding = (): RunBinding => ({ started: 'indeterminate' });

    const resolve = createResolveRunDefinition({ pointer, catalogEntry, runBinding });
    const load: FlowLoad = resolve(wt, globalRoot).load;

    expect(load.ok).toBe(false); // §18.1 error hold — NOT the present local flow
  });
});

// The negative complement of the hold above: the started-ness branch has three outcomes and only the
// 'indeterminate' one holds at the §18.1 error. A PRESENT non-indeterminate signal must NOT trigger that hold —
// an over-hold on a valid signal would brick resolution — so each present signal is pinned here.
describe('resolveRunDefinition — proceeds on a present non-indeterminate started-ness (§18.7.4)', () => {
  const fx = createWorktreeFixture();
  const catalog = createCatalogFixture();
  afterEach(() => {
    fx.cleanup();
    catalog.cleanup();
  });

  const definitionName = (load: FlowLoad): string => {
    if (!load.ok) throw new Error(`expected a resolved definition, got error: ${load.error}`);
    return load.definition.name;
  };

  const seedPresentWorktree = (): { wt: string; globalRoot: string; flowDir: string } => {
    const wt = fx.makeWorktree('present'); // .agent-terminal/ exists, but NO local flow.yaml
    const globalRoot = fx.makeWorktree('global');
    fx.writeFlowHome(globalRoot, { name: 'global-flow', stepIds: ['global-step'] });
    const flowDir = catalog.addEntry(catalog.makeCatalogDir(), 'catalog-flow');
    return { wt, globalRoot, flowDir };
  };

  it("a present 'never-started' started-ness runs the three legs and resolves the pointed-to catalog flow, never holding at the error", () => {
    const { wt, globalRoot, flowDir } = seedPresentWorktree();

    const pointer: () => PointerRead = () => ({ kind: 'value', id: 'catalog-flow' });
    const catalogEntry = (id: string): CatalogResolution =>
      id === 'catalog-flow' ? { ok: true, tier: 'repo', flowDir } : { ok: false, cause: 'unknown' };
    const runBinding = (): RunBinding => ({ started: 'never-started' });

    const resolve = createResolveRunDefinition({ pointer, catalogEntry, runBinding });
    const load: FlowLoad = resolve(wt, globalRoot).load;

    // A never-started worktree runs the three legs, so leg 1 resolves the pointer's catalog flow specifically
    // (not merely load.ok): an over-hold fails here, AND a regression that skipped leg 1 to the global fallback
    // ('global-flow', also ok:true) is caught by pinning the resolved definition.
    expect(definitionName(load)).toBe('catalog-flow');
  });

  it("a present 'started' started-ness does not trigger the indeterminate hold", () => {
    const { wt, globalRoot, flowDir } = seedPresentWorktree();

    const pointer: () => PointerRead = () => ({ kind: 'value', id: 'catalog-flow' });
    const catalogEntry = (id: string): CatalogResolution =>
      id === 'catalog-flow' ? { ok: true, tier: 'repo', flowDir } : { ok: false, cause: 'unknown' };
    // A begun run always carries the source it is bound to (the run-binding union makes 'started' without a
    // disposition unrepresentable); a non-catalog binding resolves the live local↔global chain.
    const runBinding = (): RunBinding => ({ started: 'started', disposition: { source: 'non-catalog' } });

    const resolve = createResolveRunDefinition({ pointer, catalogEntry, runBinding });
    const load: FlowLoad = resolve(wt, globalRoot).load;

    // Only the over-hold is pinned here: a begun run must NOT hold at the §18.1 error. WHICH source a begun run
    // resolves is the disposition's job (resolveRunDefinition.sourceSticky.test.ts); a non-catalog binding
    // resolves the live source, so load.ok — the point is simply that 'started' escapes the indeterminate hold.
    expect(load.ok).toBe(true);
  });
});
