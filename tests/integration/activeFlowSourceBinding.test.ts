import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createWorktreeFixture } from '../helpers/worktreeFixture';
import { flowCatalogDir, FLOW_DEF_FILE } from '../../src/main/flow';
import { createRunResolver } from '../../src/main/runResolver';
import { writeActiveFlow } from '../../src/main/activeFlowPointer';
import { recordDisposition } from '../../src/main/runDisposition';

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
});
