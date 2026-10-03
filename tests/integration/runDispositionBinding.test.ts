import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { createWorktreeFixture } from '../helpers/worktreeFixture';
import { recordDisposition, readRunBinding, runDispositionFile } from '../../src/main/runDisposition';

// A2 (#133) §18.7.3 AC9 — the run-scoped source binding the disposition persists and a begun run re-resolves.
// The round-trip pins record↔read single-sourcing; the null legs pin the fail-closed validation (CWE-20/400):
// a begun run whose recorded source cannot be trusted reads null, and the use site (runResolver) turns that
// into the §18.1 error rather than a live re-resolution (never a silent source swap, CWE-841).
describe('runDisposition source binding — round-trip + fail-closed validation (§18.7.3 AC9)', () => {
  const fx = createWorktreeFixture();
  afterEach(() => fx.cleanup());

  const writeRaw = (wt: string, doc: unknown): void => writeFileSync(runDispositionFile(wt), yaml.dump(doc));

  it('round-trips a catalog binding (source + tier + id)', () => {
    const wt = fx.makeWorktree('a2-bind-catalog');
    recordDisposition(wt, { source: 'catalog', tier: 'repo', id: 'flow-x' });
    expect(readRunBinding(wt)).toEqual({ source: 'catalog', tier: 'repo', id: 'flow-x' });
  });

  it('round-trips a global-tier catalog binding', () => {
    const wt = fx.makeWorktree('a2-bind-global');
    recordDisposition(wt, { source: 'catalog', tier: 'global', id: 'shared-flow' });
    expect(readRunBinding(wt)).toEqual({ source: 'catalog', tier: 'global', id: 'shared-flow' });
  });

  it('round-trips a non-catalog binding', () => {
    const wt = fx.makeWorktree('a2-bind-noncatalog');
    recordDisposition(wt, { source: 'non-catalog' });
    expect(readRunBinding(wt)).toEqual({ source: 'non-catalog' });
  });

  it('reads null when no disposition was recorded', () => {
    const wt = fx.makeWorktree('a2-bind-absent');
    expect(readRunBinding(wt)).toBeNull();
  });

  it('reads null (fail-closed) for a catalog binding with an out-of-set tier (CWE-20)', () => {
    const wt = fx.makeWorktree('a2-bind-bad-tier');
    writeRaw(wt, { schema_version: 1, source: 'catalog', tier: 'elsewhere', id: 'flow-x' });
    expect(readRunBinding(wt)).toBeNull();
  });

  it('reads null (fail-closed) for a catalog binding with an unsafe id (CWE-20)', () => {
    const wt = fx.makeWorktree('a2-bind-bad-id');
    writeRaw(wt, { schema_version: 1, source: 'catalog', tier: 'repo', id: '../escape' });
    expect(readRunBinding(wt)).toBeNull();
  });

  it('reads null (fail-closed) for an unknown source (CWE-20)', () => {
    const wt = fx.makeWorktree('a2-bind-bad-source');
    writeRaw(wt, { schema_version: 1, source: 'whatever' });
    expect(readRunBinding(wt)).toBeNull();
  });

  it('reads null (fail-closed) for an over-cap disposition file (CWE-400)', () => {
    const wt = fx.makeWorktree('a2-bind-oversize');
    writeRaw(wt, { schema_version: 1, source: 'non-catalog', pad: 'x'.repeat(5000) });
    expect(readRunBinding(wt)).toBeNull();
  });
});
