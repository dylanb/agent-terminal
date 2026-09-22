import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createWorktreeFixture } from '../helpers/worktreeFixture';
import { flowCatalogDir, FLOW_DEF_FILE } from '../../src/main/flow';
import { createRunResolver } from '../../src/main/runResolver';
import { writeActiveFlow } from '../../src/main/activeFlowPointer';
import { recordDisposition, runDispositionFile } from '../../src/main/runDisposition';

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
    const resolve = createRunResolver(globalDir);

    const fresh = resolve(wt); // never-started → binds flow-x
    expect(runName(fresh.load)).toBe('flow-x');
    recordDisposition(wt, fresh.binding ?? { source: 'non-catalog' }); // begin the run bound to flow-x

    writeActiveFlow(wt, 'flow-y'); // the operator re-points mid-run
    expect(runName(resolve(wt).load)).toBe('flow-x'); // the begun run ignores the change
  });

  it('a begun catalog run whose bound entry is removed surfaces the §18.1 error, never a live swap', () => {
    const wt = fx.makeWorktree('a2-swap-lost');
    const globalDir = fx.makeWorktree('a2-swap-lost-global');
    fx.writeFlowHome(globalDir, { name: 'global-fallback', stepIds: ['g-step'] }); // a fallback exists to swap TO
    seedEntry(wt, 'flow-x', 'flow-x', 'x-step');
    writeActiveFlow(wt, 'flow-x');
    const resolve = createRunResolver(globalDir);

    recordDisposition(wt, resolve(wt).binding ?? { source: 'non-catalog' }); // begin bound to flow-x
    rmSync(join(flowCatalogDir(wt), 'flow-x'), { recursive: true, force: true }); // the source is gone

    const begun = resolve(wt).load;
    expect(begun.ok).toBe(false);
    expect(begun.ok ? '' : begun.error).toContain('recorded flow source'); // §18.1 error, not the fallback
  });

  it('a run begun from a local flow.yaml never consults the pointer for its lifetime', () => {
    const wt = fx.makeWorktree('a2-swap-local');
    const globalDir = fx.makeWorktree('a2-swap-local-global');
    fx.writeFlowHome(wt, { name: 'local-only', stepIds: ['local-step'] }); // leg 1 wins
    seedEntry(wt, 'flow-x', 'flow-x', 'x-step');
    const resolve = createRunResolver(globalDir);

    const fresh = resolve(wt); // never-started → leg 1 local, binds non-catalog
    expect(runName(fresh.load)).toBe('local-only');
    recordDisposition(wt, fresh.binding ?? { source: 'non-catalog' });

    writeActiveFlow(wt, 'flow-x'); // a pointer is set AFTER the run began
    expect(runName(resolve(wt).load)).toBe('local-only'); // non-catalog run never reads the pointer
  });

  it('a begun run with NO recorded disposition marker resolves its live source (leg 1 local flow.yaml), never the §18.1 error', () => {
    // A run whose display status is in_progress but whose durable run-disposition marker is ABSENT — a pre-AC9
    // run, an externally-seeded §27 loop state, or the accepted write-fault degrade (flow.ts start()'s
    // best-effort recordDisposition). worktreeStartedness reads 'started' from the display status, but no binding
    // was ever recorded. An absent binding is not a corrupt one (§18.7.4 leaves this to the live legs, as the
    // write gate itself degrades to the display status), so the run must resolve its live source rather than fail
    // closed. Failing closed here erased the whole §27 loop view (the human-needed status-alert never rendered).
    const wt = fx.makeWorktree('a2-begun-no-marker');
    const globalDir = fx.makeWorktree('a2-begun-no-marker-global');
    fx.writeFlowHome(wt, { name: 'local-only', stepIds: ['build'] }); // leg 1 local flow.yaml
    fx.writeFlowState(wt, { step: 'build', status: 'in_progress' }); // begun via display status; recordDisposition never called
    const resolve = createRunResolver(globalDir);

    expect(runName(resolve(wt).load)).toBe('local-only');
  });

  it('a begun run whose PRESENT disposition marker is corrupt still holds at the §18.1 error, never deferring to the live legs (CWE-841)', () => {
    // The boundary the absent-marker defer must not cross: a marker that EXISTS but whose binding cannot be read
    // is a recorded-but-untrustworthy source, not an absent one — it fails closed, exactly as before. A leg-1
    // local flow.yaml is present so a wrongful defer would resolve it (load.ok), making the hold observable.
    const wt = fx.makeWorktree('a2-corrupt-marker');
    const globalDir = fx.makeWorktree('a2-corrupt-marker-global');
    fx.writeFlowHome(wt, { name: 'local-only', stepIds: ['build'] });
    fx.writeFlowState(wt, { step: 'build', status: 'in_progress' }); // started via the display status
    writeFileSync(runDispositionFile(wt), 'source: totally-bogus\n'); // marker PRESENT, its binding unreadable
    const resolve = createRunResolver(globalDir);

    expect(resolve(wt).load.ok).toBe(false);
  });
});
