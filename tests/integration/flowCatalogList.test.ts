import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';
import { createCatalogFixture } from '../helpers/catalogFixture';
import { createWorktreeFixture } from '../helpers/worktreeFixture';
import { flowCatalogDir } from '../../src/main/flow';
import { activeFlowPointerFile, writeActiveFlow } from '../../src/main/activeFlowPointer';
import { listCatalog } from '../../src/main/flowCatalogList';
import { resolveCatalogEntry } from '../../src/main/flowCatalog';
import { MAX_CATALOG_ID_LENGTH } from '../../src/shared/pathSegment';
import type { FlowCatalogListing } from '../../src/shared/ipc';

// A3 (#134) §18.7.6 "The catalog-listing seam carries the worktree it lists" — the picker's listing is computed
// for the NAMED worktree against real on-disk tiers, never from ambient state (AC2), with the flags the picker
// and recovery read (AC1 highlight, local / fallback origins).

const wt = createWorktreeFixture();
const catalog = createCatalogFixture();
afterEach(() => {
  catalog.cleanup();
  wt.cleanup();
});

function world(): { home: string; repo(prefix: string): string } {
  const home = realpathSync(wt.makeFirstRunWorktree('a3-list-home'));
  return {
    home,
    repo: (prefix) => realpathSync(wt.makeFirstRunWorktree(prefix)),
  };
}

const availableIds = (l: FlowCatalogListing): string[] =>
  l.entries.flatMap((e) => (e.available ? [`${e.origin}:${e.id}`] : [])).sort();

describe('listCatalog — per named worktree (AC2)', () => {
  it("lists each worktree's own repo-tier entries plus the shared global entries, and never another repo's", () => {
    const w = world();
    const repoA = w.repo('a3-list-repo-a');
    const repoB = w.repo('a3-list-repo-b');
    catalog.addEntryWithSteps(flowCatalogDir(w.home), 'shared-g', ['g1']);
    catalog.addEntryWithSteps(flowCatalogDir(repoA), 'only-in-a', ['a1']);
    catalog.addEntryWithSteps(flowCatalogDir(repoB), 'only-in-b', ['b1']);

    const listingA = listCatalog({ worktreeDir: repoA, globalRoot: w.home });
    const listingB = listCatalog({ worktreeDir: repoB, globalRoot: w.home });
    expect(availableIds(listingA)).toEqual(['global:shared-g', 'repo:only-in-a']);
    expect(availableIds(listingB)).toEqual(['global:shared-g', 'repo:only-in-b']);
    expect(listingA.entries.map((e) => (e.available ? e.id : e.label)).sort()).toEqual(['only-in-a', 'shared-g']);
    expect(listingB.entries.map((e) => (e.available ? e.id : e.label)).sort()).toEqual(['only-in-b', 'shared-g']);
  });

  it('offers a name present in both tiers once, from the repo tier (§18.1 merged library, repo wins)', () => {
    const w = world();
    const repo = w.repo('a3-list-clash');
    catalog.addEntryWithSteps(flowCatalogDir(w.home), 'clash', ['g1']);
    catalog.addEntryWithSteps(flowCatalogDir(repo), 'clash', ['r1']);

    const listing = listCatalog({ worktreeDir: repo, globalRoot: w.home });
    expect(availableIds(listing)).toEqual(['repo:clash']);
    expect(listing.entries).toHaveLength(1);
  });

  it('a repo-tier directory holding no flow.yaml does not shadow the global entry of the same name', () => {
    const w = world();
    const repo = w.repo('a3-list-hollow-shadow');
    catalog.addEntryWithSteps(flowCatalogDir(w.home), 'same', ['g1']);
    mkdirSync(join(flowCatalogDir(repo), 'same'), { recursive: true });

    const listing = listCatalog({ worktreeDir: repo, globalRoot: w.home });
    expect(availableIds(listing)).toEqual(['global:same']);
    const resumable = listing.resumable.map((r) => `${r.origin}:${r.id}`);
    expect(resumable).toContain('global:same');
    expect(resumable).not.toContain('repo:same');
  });

  it('offers both tiers of a clashing name to recovery, each resolved within its own tier', () => {
    const w = world();
    const repo = w.repo('a3-list-resumable');
    catalog.addEntryWithSteps(flowCatalogDir(w.home), 'clash', ['g1']);
    catalog.addEntryWithSteps(flowCatalogDir(repo), 'clash', ['r1']);
    catalog.addEntryWithSteps(flowCatalogDir(w.home), 'solo', ['s1']);

    const resumable = listCatalog({ worktreeDir: repo, globalRoot: w.home }).resumable.map((r) => `${r.origin}:${r.id}`).sort();
    expect(resumable).toEqual(['global:clash', 'global:solo', 'repo:clash']);
  });

  it('every row it offers resolves through the pointer\'s availability check to the same tier', () => {
    const w = world();
    const repo = w.repo('a3-list-agree');
    catalog.addEntryWithSteps(flowCatalogDir(w.home), 'g-only', ['g1']);
    catalog.addEntryWithSteps(flowCatalogDir(repo), 'r-only', ['r1']);
    catalog.addEntryWithSteps(flowCatalogDir(w.home), 'clash', ['g1']);
    catalog.addEntryWithSteps(flowCatalogDir(repo), 'clash', ['r1']);
    const roots = { worktreeDir: repo, globalRoot: w.home };

    const listing = listCatalog(roots);
    expect(availableIds(listing)).toEqual(['global:g-only', 'repo:clash', 'repo:r-only']);
    for (const e of listing.entries) {
      if (e.available) expect(resolveCatalogEntry(roots, e.id), e.id).toMatchObject({ ok: true, tier: e.origin });
    }
    for (const r of listing.resumable) {
      expect(resolveCatalogEntry(roots, r.id, r.origin), `${r.origin}:${r.id}`).toMatchObject({ ok: true, tier: r.origin });
    }
  });

  it("agrees with the pointer's availability check when the repo tier is a symlink to a directory inside the worktree", () => {
    const w = world();
    const repo = w.repo('a3-list-linked-tier');
    const target = join(repo, 'shared-flows');
    catalog.addEntryWithSteps(target, 'linked', ['l1']);
    catalog.addEntryWithSteps(flowCatalogDir(w.home), 'g-only', ['g1']);
    mkdirSync(dirname(flowCatalogDir(repo)), { recursive: true });
    symlinkSync(target, flowCatalogDir(repo));
    const roots = { worktreeDir: repo, globalRoot: w.home };

    const listing = listCatalog(roots);
    const nameOf = (e: FlowCatalogListing['entries'][number]): string => (e.available ? e.id : e.label);
    expect(listing.entries.map(nameOf).sort()).toEqual(['g-only', 'linked']);
    for (const e of listing.entries) {
      const verdict = resolveCatalogEntry(roots, nameOf(e));
      expect(e.available, nameOf(e)).toBe(verdict.ok);
      if (verdict.ok) expect(e.origin, nameOf(e)).toBe(verdict.tier);
    }
  });

  it('does not list a directory in a tier that holds no flow.yaml', () => {
    const w = world();
    const repo = w.repo('a3-list-nodef');
    catalog.addEntryWithSteps(flowCatalogDir(w.home), 'real', ['g1']);
    mkdirSync(join(flowCatalogDir(w.home), 'hollow'), { recursive: true });

    const listing = listCatalog({ worktreeDir: repo, globalRoot: w.home });
    expect(availableIds(listing)).toEqual(['global:real']);
    expect(listing.entries).toHaveLength(1);
  });
});

describe('listCatalog — listing flags', () => {
  it("carries the worktree's pointer id as selectedId when it reads as a value, and omits it when unset", () => {
    const w = world();
    const repo = w.repo('a3-list-selected');
    catalog.addEntryWithSteps(flowCatalogDir(w.home), 'first', ['f1']);
    catalog.addEntryWithSteps(flowCatalogDir(w.home), 'second', ['s1']);
    const roots = { worktreeDir: repo, globalRoot: w.home };

    expect(listCatalog(roots).selectedId).toBeUndefined();
    writeActiveFlow(repo, 'second');
    expect(listCatalog(roots).selectedId).toBe('second');
  });

  it('carries a safe pointer id that matches no row as selectedId', () => {
    const w = world();
    const repo = w.repo('a3-list-unknown-sel');
    catalog.addEntryWithSteps(flowCatalogDir(w.home), 'first', ['f1']);
    writeActiveFlow(repo, 'no-such-flow');

    expect(listCatalog({ worktreeDir: repo, globalRoot: w.home }).selectedId).toBe('no-such-flow');
  });

  it.each([
    ['an escaping id', '../escape'],
    ['bidi and zero-width text', 'fir\u202Est\u200B'],
    ['an over-long id', 'x'.repeat(MAX_CATALOG_ID_LENGTH + 1)],
  ])('drops selectedId when the pointer holds %s (a degrade, never the raw text)', (_label, raw) => {
    const w = world();
    const repo = w.repo('a3-list-degrade-sel');
    catalog.addEntryWithSteps(flowCatalogDir(w.home), 'first', ['f1']);
    const roots = { worktreeDir: repo, globalRoot: w.home };
    writeActiveFlow(repo, 'first');
    expect(listCatalog(roots).selectedId).toBe('first');

    const pointer = activeFlowPointerFile(repo);
    mkdirSync(dirname(pointer), { recursive: true });
    writeFileSync(pointer, yaml.dump(raw));

    expect(listCatalog(roots).selectedId).toBeUndefined();
  });

  it("reports hasLocalFlow and hasGlobalFallback from the worktree's flow.yaml and the global fallback file", () => {
    const w = world();
    const repo = w.repo('a3-list-flags');
    const roots = { worktreeDir: repo, globalRoot: w.home };

    expect(listCatalog(roots)).toMatchObject({ hasLocalFlow: false, hasGlobalFallback: false });
    wt.writeFlowHome(repo, { name: 'local', stepIds: ['l1'] });
    wt.writeFlowHome(w.home, { name: 'fallback', stepIds: ['fb1'] });
    expect(listCatalog(roots)).toMatchObject({ hasLocalFlow: true, hasGlobalFallback: true });
  });

  it('reports hasLocalFlow and hasGlobalFallback independently of each other', () => {
    const w = world();
    const localOnly = w.repo('a3-list-flags-local');
    wt.writeFlowHome(localOnly, { name: 'local', stepIds: ['l1'] });
    expect(listCatalog({ worktreeDir: localOnly, globalRoot: w.home })).toMatchObject({ hasLocalFlow: true, hasGlobalFallback: false });

    const w2 = world();
    const fallbackOnly = w2.repo('a3-list-flags-fallback');
    wt.writeFlowHome(w2.home, { name: 'fallback', stepIds: ['fb1'] });
    expect(listCatalog({ worktreeDir: fallbackOnly, globalRoot: w2.home })).toMatchObject({ hasLocalFlow: false, hasGlobalFallback: true });
  });
});
