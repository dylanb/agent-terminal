// A2 (#133) §18.7.6 — resolveCatalogEntry over REAL on-disk catalog tiers. The resolver walks the confined
// resolved path (never a re-resolution of the raw id, CWE-367), repo tier first, so this pins tier precedence
// and the refusal taxonomy (escapes / unresolvable / unknown) at the observable return value, over real dirs
// and real symlinks — no mocks (CLAUDE.md).

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveCatalogEntry } from '../../src/main/flowCatalog';
import { flowCatalogDir, FLOW_DEF_FILE } from '../../src/main/flow';
import { createWorktreeFixture } from '../helpers/worktreeFixture';
import { createCatalogFixture } from '../helpers/catalogFixture';

const worktrees = createWorktreeFixture();
const catalogs = createCatalogFixture();
afterEach(() => {
  worktrees.cleanup();
  catalogs.cleanup();
});

/** Seed `<root>/.agent-terminal/flows/<id>/flow.yaml` (+ templates) — the tier the resolver reads. Returns the
 *  symlink-free real entry dir, since the resolver returns the confined REAL path (macOS /var → /private/var). */
function installCatalogEntry(root: string, id: string): string {
  return realpathSync(catalogs.addEntry(flowCatalogDir(root), id));
}

describe('resolveCatalogEntry (§18.7.6 per-tier catalog resolution)', () => {
  it('resolves an installed repo-tier id to its entry dir, tier "repo"', () => {
    const wt = worktrees.makeWorktree('flowcat-repo');
    const global = worktrees.makeWorktree('flowcat-global');
    const entry = installCatalogEntry(wt, 'feature-dev');

    const res = resolveCatalogEntry({ worktreeDir: wt, globalRoot: global }, 'feature-dev');

    expect(res).toEqual({ ok: true, tier: 'repo', flowDir: entry });
    expect(existsSync(join(res.ok ? res.flowDir : '', FLOW_DEF_FILE))).toBe(true);
  });

  it('falls to the global tier when the id is absent from the repo tier', () => {
    const wt = worktrees.makeWorktree('flowcat-repo');
    const global = worktrees.makeWorktree('flowcat-global');
    const entry = installCatalogEntry(global, 'plan-only');

    const res = resolveCatalogEntry({ worktreeDir: wt, globalRoot: global }, 'plan-only');

    expect(res).toEqual({ ok: true, tier: 'global', flowDir: entry });
  });

  it('resolves the REPO entry when the same id exists in both tiers (repo wins the clash)', () => {
    const wt = worktrees.makeWorktree('flowcat-repo');
    const global = worktrees.makeWorktree('flowcat-global');
    const repoEntry = installCatalogEntry(wt, 'feature-dev');
    installCatalogEntry(global, 'feature-dev');

    const res = resolveCatalogEntry({ worktreeDir: wt, globalRoot: global }, 'feature-dev');

    expect(res).toEqual({ ok: true, tier: 'repo', flowDir: repoEntry });
  });

  it('is "unknown" for an id installed in neither tier', () => {
    const wt = worktrees.makeWorktree('flowcat-repo');
    const global = worktrees.makeWorktree('flowcat-global');
    installCatalogEntry(global, 'plan-only');

    expect(resolveCatalogEntry({ worktreeDir: wt, globalRoot: global }, 'nope')).toEqual({
      ok: false,
      cause: 'unknown',
    });
  });

  it('is "unknown" for an unsafe id, without walking a path (the shared safe-catalog-id gate)', () => {
    const wt = worktrees.makeWorktree('flowcat-repo');
    const global = worktrees.makeWorktree('flowcat-global');

    expect(resolveCatalogEntry({ worktreeDir: wt, globalRoot: global }, '../escape')).toEqual({
      ok: false,
      cause: 'unknown',
    });
  });

  it('refuses "escapes" when the resolved entry is a symlink escaping the tier jail (CWE-59), never the target', () => {
    const wt = worktrees.makeWorktree('flowcat-repo');
    const global = worktrees.makeWorktree('flowcat-global');
    installCatalogEntry(wt, 'evil');
    catalogs.symlinkEntryFlowYaml(flowCatalogDir(wt), 'evil');

    expect(resolveCatalogEntry({ worktreeDir: wt, globalRoot: global }, 'evil')).toEqual({
      ok: false,
      cause: 'escapes',
    });
  });

  it('refuses "unresolvable" when the repo-tier entry cannot be reduced to a real path, never falling through to global (§18.7.6 precedence-inversion)', () => {
    const wt = worktrees.makeWorktree('flowcat-repo');
    const global = worktrees.makeWorktree('flowcat-global');
    installCatalogEntry(wt, 'feature-dev');
    catalogs.danglingEntryFlowYaml(flowCatalogDir(wt), 'feature-dev');
    // The SAME id also lives in the global tier: an unreadable repo tier read as empty would silently swap the
    // source to the global entry. The guard refuses with the distinct "could not be read" cause instead.
    installCatalogEntry(global, 'feature-dev');

    expect(resolveCatalogEntry({ worktreeDir: wt, globalRoot: global }, 'feature-dev')).toEqual({
      ok: false,
      cause: 'unresolvable',
    });
  });

  it('refuses "escapes" on a GLOBAL-tier symlinked entry (repo absent), never following the redirected target', () => {
    const wt = worktrees.makeWorktree('flowcat-repo');
    const global = worktrees.makeWorktree('flowcat-global');
    installCatalogEntry(global, 'evil');
    catalogs.symlinkEntryFlowYaml(flowCatalogDir(global), 'evil');
    // The repo tier has no such member → the resolver falls through to the global tier, whose entry escapes
    // its app-owned jail. A regression that swallowed a global-tier escape to 'unknown' — or followed the
    // redirected target to ok:true — passes every repo-tier case; only this global-tier pin catches it.
    expect(resolveCatalogEntry({ worktreeDir: wt, globalRoot: global }, 'evil')).toEqual({
      ok: false,
      cause: 'escapes',
    });
  });

  it('refuses "unresolvable" on a GLOBAL-tier dangling entry (repo absent)', () => {
    const wt = worktrees.makeWorktree('flowcat-repo');
    const global = worktrees.makeWorktree('flowcat-global');
    installCatalogEntry(global, 'flaky');
    catalogs.danglingEntryFlowYaml(flowCatalogDir(global), 'flaky');
    expect(resolveCatalogEntry({ worktreeDir: wt, globalRoot: global }, 'flaky')).toEqual({
      ok: false,
      cause: 'unresolvable',
    });
  });

  it('refuses a repo-tier entry reached only through a symlinked `flows` dir — resolveJail never adopts the planted link as its jail (CWE-59; the per-tier resolver choice)', () => {
    const wt = worktrees.makeWorktree('flowcat-flowsdir-escape');
    const global = worktrees.makeWorktree('flowcat-global');
    // Plant the repo's own `.agent-terminal/flows` as a symlink to out-of-worktree ground that DOES hold a
    // structurally-valid `evil/flow.yaml`. The repo tier uses resolveJail, which appends `flows` UNRESOLVED,
    // so the entry resolves outside the literal jail and is refused ('escapes'); swapping the repo tier to
    // resolveOwnedDirJail — which would realpath the `flows` symlink and adopt its target as the jail — would
    // ADMIT it (ok:true). This is the per-tier resolver choice CLAUDE.md calls "getting that backwards is the
    // bug"; the existing escape test plants the link INSIDE the jail and so cannot discriminate the two.
    const target = join(catalogs.outsideDir(), 'planted-flows');
    mkdirSync(join(target, 'evil'), { recursive: true });
    writeFileSync(join(target, 'evil', FLOW_DEF_FILE), 'name: evil\nsteps:\n  - id: only\n    kind: manual\n');
    symlinkSync(target, flowCatalogDir(wt));

    expect(resolveCatalogEntry({ worktreeDir: wt, globalRoot: global }, 'evil')).toEqual({
      ok: false,
      cause: 'escapes',
    });
  });
});
