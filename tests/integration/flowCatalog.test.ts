// A2 (#133) §18.7.6 — resolveCatalogEntry over REAL on-disk catalog tiers. The resolver walks the confined
// resolved path (never a re-resolution of the raw id, CWE-367), repo tier first, so this pins tier precedence
// and the degrade taxonomy (escapes / unresolvable / unknown) at the observable return value, over real dirs
// and real symlinks — no mocks (CLAUDE.md).

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, realpathSync } from 'node:fs';
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

  it('degrades "escapes" when the resolved entry is a symlink escaping the tier jail (CWE-59), never the target', () => {
    const wt = worktrees.makeWorktree('flowcat-repo');
    const global = worktrees.makeWorktree('flowcat-global');
    installCatalogEntry(wt, 'evil');
    catalogs.symlinkEntryFlowYaml(flowCatalogDir(wt), 'evil');

    expect(resolveCatalogEntry({ worktreeDir: wt, globalRoot: global }, 'evil')).toEqual({
      ok: false,
      cause: 'escapes',
    });
  });
});
