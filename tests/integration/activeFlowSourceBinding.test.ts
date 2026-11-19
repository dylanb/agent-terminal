import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createWorktreeFixture } from '../helpers/worktreeFixture';
import { flowCatalogDir, FLOW_DEF_FILE } from '../../src/main/flow';
import { createRunResolver } from '../../src/main/runResolver';
import { writeActiveFlow } from '../../src/main/activeFlowPointer';
import { readRunBinding, recordDisposition, runDispositionFile } from '../../src/main/runDisposition';
import { createFlowManager } from '../../src/main/flow';
import { repoOnlyDefTiers } from '../helpers/defTiers';

// A2 (#133) §18.7.3 AC9 — a begun run resolves its RECORDED source, never the live pointer: it never silently
// switches which tier/entry supplies its definition, a lost bound source surfaces the §18.1 error rather than a
// live swap to the fallback, and a run begun from a local (non-catalog) source never consults the pointer for
// its lifetime (CWE-841). Drives the real production resolver (createRunResolver) over real fixtures.
describe('run-scoped source binding — a begun run never swaps its source (§18.7.3 AC9)', () => {
  const fx = createWorktreeFixture();
  afterEach(() => fx.cleanup());

  const flowYaml = (name: string, ...steps: string[]): string =>
    `name: ${name}\nsteps:\n` + steps.map((s) => `  - id: ${s}\n    kind: manual\n`).join('');
  const seedEntry = (root: string, id: string, name: string, ...steps: string[]): void => {
    const dir = join(flowCatalogDir(root), id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, FLOW_DEF_FILE), flowYaml(name, ...steps));
  };
  const runName = (load: { ok: true; definition: { name: string } } | { ok: false; error: string }): string =>
    load.ok ? load.definition.name : `<error: ${load.error}>`;

  it('a begun catalog run keeps resolving its bound entry after the pointer is changed (CWE-841)', () => {
    const wt = fx.makeWorktree('a2-swap-catalog');
    const globalDir = fx.makeWorktree('a2-swap-catalog-global');
    seedEntry(wt, 'flow-x', 'flow-x', 'x-step');
    seedEntry(wt, 'flow-y', 'flow-y', 'y-step');
    writeActiveFlow(wt, 'flow-x');
    const resolve = createRunResolver(globalDir, repoOnlyDefTiers());

    const fresh = resolve(wt); // never-started → binds flow-x
    expect(runName(fresh.load)).toBe('flow-x');
    recordDisposition(wt, fresh.binding ?? { source: 'non-catalog' }); // begin the run bound to flow-x

    writeActiveFlow(wt, 'flow-y'); // the operator re-points mid-run
    expect(runName(resolve(wt).load)).toBe('flow-x'); // the begun run ignores the change
  });

  it('a re-Start after a first-step revertStep resolves the still-set pointer afresh, binding its catalog entry', () => {
    const wt = fx.makeWorktree('a2-restart-after-revert');
    const globalDir = fx.makeWorktree('a2-restart-after-revert-global');
    fx.writeFlowHome(globalDir, { name: 'global-fallback', stepIds: ['g-step'] }); // a fallback exists to swap TO
    seedEntry(wt, 'flow-x', 'flow-x', 'x-step', 'x-next');
    writeActiveFlow(wt, 'flow-x');
    const resolve = createRunResolver(globalDir, repoOnlyDefTiers());
    const mgr = createFlowManager({ globalDir, loadDefinition: (repoKey) => resolve(repoKey) });

    mgr.start(wt);
    mgr.revertStep(wt, 'x-step'); // first-step rollback → never-started; the pointer still names flow-x
    mgr.start(wt); // the documented recovery

    expect(readRunBinding(wt)).toEqual({ source: 'catalog', tier: 'repo', id: 'flow-x' });
    expect(mgr.state(wt).steps).toEqual(['x-step', 'x-next']);
  });

  it('a run begun on the global fallback never consults a pointer set later', () => {
    const wt = fx.makeWorktree('a2-begun-fallback');
    const globalDir = fx.makeWorktree('a2-begun-fallback-global');
    fx.writeFlowHome(globalDir, { name: 'global-fallback', stepIds: ['g-step'] });
    seedEntry(wt, 'flow-x', 'flow-x', 'x-step');
    const resolve = createRunResolver(globalDir, repoOnlyDefTiers());
    const mgr = createFlowManager({ globalDir, loadDefinition: (repoKey) => resolve(repoKey) });

    mgr.start(wt);
    writeActiveFlow(wt, 'flow-x');

    expect(mgr.state(wt).steps).toEqual(['g-step']);
  });

  it("AC18: a pick over a present local flow.yaml is what Start runs and binds, and it survives a relaunch", () => {
    const wt = fx.makeWorktree('a3-pick-over-local');
    const globalDir = fx.makeWorktree('a3-pick-over-local-global');
    fx.writeFlowHome(wt, { name: 'local-flow', stepIds: ['l-step'] });
    seedEntry(globalDir, 'flow-g', 'flow-g', 'g-step', 'g-next');
    writeActiveFlow(wt, 'flow-g');
    const resolve = createRunResolver(globalDir, repoOnlyDefTiers());
    const mgr = createFlowManager({ globalDir, loadDefinition: (repoKey) => resolve(repoKey) });

    const started = mgr.start(wt);

    expect(started.status).toBe('in_progress');
    expect(started.steps).toEqual(['g-step', 'g-next']);
    expect(readRunBinding(wt)).toEqual({ source: 'catalog', tier: 'global', id: 'flow-g' });

    const relaunchedResolve = createRunResolver(globalDir, repoOnlyDefTiers());
    const relaunched = createFlowManager({ globalDir, loadDefinition: (repoKey) => relaunchedResolve(repoKey) });
    expect(relaunched.state(wt).steps).toEqual(['g-step', 'g-next']);
    expect(relaunched.state(wt).status).toBe('in_progress');
  });

  it('an unusable pick cannot be started on the local flow or the global fallback', () => {
    const wt = fx.makeWorktree('a2-refused-pick');
    const globalDir = fx.makeWorktree('a2-refused-pick-global');
    fx.writeFlowHome(globalDir, { name: 'global-fallback', stepIds: ['g-step'] });
    fx.writeFlowHome(wt, { name: 'local-flow', stepIds: ['l-step'] });
    writeActiveFlow(wt, 'missing-flow');
    const resolve = createRunResolver(globalDir, repoOnlyDefTiers());
    const mgr = createFlowManager({ globalDir, loadDefinition: (repoKey) => resolve(repoKey) });

    const view = mgr.start(wt);

    expect(view.status).toBe('error');
    expect(view.error).toContain('missing-flow');
    expect(mgr.state(wt).runStarted).toBe('never-started');
  });

  it('a begun GLOBAL-tier catalog run keeps resolving its global entry after a same-named repo entry appears (§18.7.3)', () => {
    const wt = fx.makeWorktree('a2-bound-global');
    const globalDir = fx.makeWorktree('a2-bound-global-global');
    seedEntry(globalDir, 'flow-g', 'global-flow-g', 'g-step');
    writeActiveFlow(wt, 'flow-g');
    const resolve = createRunResolver(globalDir, repoOnlyDefTiers());
    const fresh = resolve(wt);
    expect(fresh.binding).toEqual({ source: 'catalog', tier: 'global', id: 'flow-g' });
    recordDisposition(wt, fresh.binding ?? { source: 'non-catalog' });

    seedEntry(wt, 'flow-g', 'repo-flow-g', 'r-step'); // a pull adds a same-named repo entry mid-run

    expect(runName(resolve(wt).load)).toBe('global-flow-g');
  });

  it('a catalog entry whose flow.yaml links to a sibling file never opens a second, unconfined path (CWE-22/59)', () => {
    const wt = fx.makeWorktree('a2-entry-redirect');
    const globalDir = fx.makeWorktree('a2-entry-redirect-global');
    const secret = join(fx.outsideDir('a2-entry-redirect-secret'), 'secret.yaml');
    writeFileSync(secret, 'SECRET-OUTSIDE-JAIL: [unterminated\n');
    mkdirSync(join(flowCatalogDir(wt), 'a'), { recursive: true });
    mkdirSync(join(flowCatalogDir(wt), 'b'), { recursive: true });
    writeFileSync(join(flowCatalogDir(wt), 'b', 'decoy.yaml'), 'name: decoy\n');
    symlinkSync(join('..', 'b', 'decoy.yaml'), join(flowCatalogDir(wt), 'a', FLOW_DEF_FILE));
    symlinkSync(secret, join(flowCatalogDir(wt), 'b', FLOW_DEF_FILE));
    writeActiveFlow(wt, 'a');

    const resolved = createRunResolver(globalDir, repoOnlyDefTiers())(wt);

    expect(JSON.stringify(resolved)).not.toContain('SECRET-OUTSIDE-JAIL');
    expect(resolved.binding).not.toEqual(expect.objectContaining({ source: 'catalog' }));
  });

  it('a begun catalog run whose bound entry is removed surfaces the §18.1 error, never a live swap', () => {
    const wt = fx.makeWorktree('a2-swap-lost');
    const globalDir = fx.makeWorktree('a2-swap-lost-global');
    fx.writeFlowHome(globalDir, { name: 'global-fallback', stepIds: ['g-step'] }); // a fallback exists to swap TO
    seedEntry(wt, 'flow-x', 'flow-x', 'x-step');
    writeActiveFlow(wt, 'flow-x');
    const resolve = createRunResolver(globalDir, repoOnlyDefTiers());

    recordDisposition(wt, resolve(wt).binding ?? { source: 'non-catalog' }); // begin bound to flow-x
    rmSync(join(flowCatalogDir(wt), 'flow-x'), { recursive: true, force: true }); // the source is gone

    const begun = resolve(wt).load;
    expect(begun.ok).toBe(false);
    expect(begun.ok ? '' : begun.error).toContain('recorded flow source'); // §18.1 error, not the fallback
  });

  it('a run begun from a local flow.yaml never consults the pointer for its lifetime', () => {
    const wt = fx.makeWorktree('a2-swap-local');
    const globalDir = fx.makeWorktree('a2-swap-local-global');
    fx.writeFlowHome(wt, { name: 'local-only', stepIds: ['local-step'] }); // no pointer set → leg 2 (local) wins
    seedEntry(wt, 'flow-x', 'flow-x', 'x-step');
    const resolve = createRunResolver(globalDir, repoOnlyDefTiers());

    const fresh = resolve(wt); // never-started → leg 2 local, binds non-catalog
    expect(runName(fresh.load)).toBe('local-only');
    recordDisposition(wt, fresh.binding ?? { source: 'non-catalog' });

    writeActiveFlow(wt, 'flow-x'); // a pointer is set AFTER the run began
    expect(runName(resolve(wt).load)).toBe('local-only'); // non-catalog run never reads the pointer
  });

  it('a begun run with NO recorded disposition marker holds at the §18.1 error, never re-resolving the live legs (CWE-841)', () => {
    // A leg-2 local flow.yaml is present so a wrongful defer to the live legs would resolve it (load.ok).
    const wt = fx.makeWorktree('a2-begun-no-marker');
    const globalDir = fx.makeWorktree('a2-begun-no-marker-global');
    fx.writeFlowHome(wt, { name: 'local-only', stepIds: ['build'] });
    fx.writeFlowState(wt, { step: 'build', status: 'in_progress' });
    const resolve = createRunResolver(globalDir, repoOnlyDefTiers());

    expect(resolve(wt).load.ok).toBe(false);
  });

  it('a begun run whose PRESENT disposition marker is corrupt still holds at the §18.1 error, never deferring to the live legs (CWE-841)', () => {
    // A leg-2 local flow.yaml is present so a wrongful defer to the live legs would resolve it (load.ok).
    const wt = fx.makeWorktree('a2-corrupt-marker');
    const globalDir = fx.makeWorktree('a2-corrupt-marker-global');
    fx.writeFlowHome(wt, { name: 'local-only', stepIds: ['build'] });
    fx.writeFlowState(wt, { step: 'build', status: 'in_progress' }); // started via the display status
    writeFileSync(runDispositionFile(wt), 'source: totally-bogus\n'); // marker PRESENT, its binding unreadable
    const resolve = createRunResolver(globalDir, repoOnlyDefTiers());

    expect(resolve(wt).load.ok).toBe(false);
  });
});
