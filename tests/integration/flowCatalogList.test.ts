import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';
import { createCatalogFixture } from '../helpers/catalogFixture';
import { createWorktreeFixture } from '../helpers/worktreeFixture';
import { flowCatalogDir, flowHomeDir } from '../../src/main/flow';
import { activeFlowPointerFile, writeActiveFlow } from '../../src/main/activeFlowPointer';
import { catalogListResult, listCatalog, MAX_CATALOG_LIST_MEMBERS } from '../../src/main/flowCatalogList';
import { catalogRefusalReason } from '../../src/main/resolveRunDefinition';
import { MAX_ECHOED_REASON_LENGTH } from '../../src/shared/controlChars';
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

/** The recovery choices a held run's listing offers, in order, as `origin[:id]`. */
const offeredToRecovery = (roots: { worktreeDir: string; globalRoot: string }): string[] =>
  listCatalog(roots, (choices) => choices.map((choice) => ({ choice, outcome: 'resumes' as const }))).recoveryOutcomes.map(({ choice }) =>
    'id' in choice ? `${choice.origin}:${choice.id}` : choice.origin,
  );

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
    const offered = offeredToRecovery({ worktreeDir: repo, globalRoot: w.home });
    expect(offered).toContain('global:same');
    expect(offered).not.toContain('repo:same');
  });

  it('offers both tiers of a clashing name to recovery, each resolved within its own tier', () => {
    const w = world();
    const repo = w.repo('a3-list-resumable');
    catalog.addEntryWithSteps(flowCatalogDir(w.home), 'clash', ['g1']);
    catalog.addEntryWithSteps(flowCatalogDir(repo), 'clash', ['r1']);
    catalog.addEntryWithSteps(flowCatalogDir(w.home), 'solo', ['s1']);

    expect(offeredToRecovery({ worktreeDir: repo, globalRoot: w.home }).sort()).toEqual(['global:clash', 'global:solo', 'repo:clash']);
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
    for (const offered of offeredToRecovery(roots)) {
      const [origin, id] = offered.split(':') as ['repo' | 'global', string];
      expect(resolveCatalogEntry(roots, id, origin), offered).toMatchObject({ ok: true, tier: origin });
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
  it("carries the worktree's pointer as a value selection when it reads as a value, and as unset when absent", () => {
    const w = world();
    const repo = w.repo('a3-list-selected');
    catalog.addEntryWithSteps(flowCatalogDir(w.home), 'first', ['f1']);
    catalog.addEntryWithSteps(flowCatalogDir(w.home), 'second', ['s1']);
    const roots = { worktreeDir: repo, globalRoot: w.home };

    expect(listCatalog(roots).selection).toEqual({ kind: 'unset' });
    writeActiveFlow(repo, 'second');
    expect(listCatalog(roots).selection).toEqual({ kind: 'value', id: 'second' });
  });

  it('carries a safe pointer id that matches no row as the value selection', () => {
    const w = world();
    const repo = w.repo('a3-list-unknown-sel');
    catalog.addEntryWithSteps(flowCatalogDir(w.home), 'first', ['f1']);
    writeActiveFlow(repo, 'no-such-flow');

    expect(listCatalog({ worktreeDir: repo, globalRoot: w.home }).selection).toEqual({ kind: 'value', id: 'no-such-flow' });
  });

  it.each([
    ['an escaping id', '../escape'],
    ['bidi and zero-width text', 'fir\u202Est\u200B'],
    ['an over-long id', 'x'.repeat(MAX_CATALOG_ID_LENGTH + 1)],
  ])('reports an invalid selection, never unset and never the raw text, when the pointer holds %s (§18.7.3 leg 1 refuses it)', (_label, raw) => {
    const w = world();
    const repo = w.repo('a3-list-invalid-sel');
    catalog.addEntryWithSteps(flowCatalogDir(w.home), 'first', ['f1']);
    const roots = { worktreeDir: repo, globalRoot: w.home };
    writeActiveFlow(repo, 'first');
    expect(listCatalog(roots).selection).toEqual({ kind: 'value', id: 'first' });

    const pointer = activeFlowPointerFile(repo);
    mkdirSync(dirname(pointer), { recursive: true });
    writeFileSync(pointer, yaml.dump(raw));

    expect(listCatalog(roots).selection).toEqual({ kind: 'invalid' });
  });

  it('reports an invalid selection when a non-file sits at the pointer path', () => {
    const w = world();
    const repo = w.repo('a3-list-nonfile-sel');
    catalog.addEntryWithSteps(flowCatalogDir(w.home), 'first', ['f1']);
    mkdirSync(activeFlowPointerFile(repo), { recursive: true });

    expect(listCatalog({ worktreeDir: repo, globalRoot: w.home }).selection).toEqual({ kind: 'invalid' });
  });

  it("offers recovery the worktree's flow.yaml first and the global fallback last, each only when its file exists", () => {
    const w = world();
    const repo = w.repo('a3-list-flags');
    const roots = { worktreeDir: repo, globalRoot: w.home };
    catalog.addEntryWithSteps(flowCatalogDir(w.home), 'g-one', ['g1']);

    expect(offeredToRecovery(roots)).toEqual(['global:g-one']);
    wt.writeFlowHome(repo, { name: 'local', stepIds: ['l1'] });
    wt.writeFlowHome(w.home, { name: 'fallback', stepIds: ['fb1'] });
    expect(offeredToRecovery(roots)).toEqual(['local', 'global:g-one', 'fallback']);
  });

  it('offers the local flow.yaml and the global fallback independently of each other', () => {
    const w = world();
    const localOnly = w.repo('a3-list-flags-local');
    wt.writeFlowHome(localOnly, { name: 'local', stepIds: ['l1'] });
    expect(offeredToRecovery({ worktreeDir: localOnly, globalRoot: w.home })).toEqual(['local']);

    const w2 = world();
    const fallbackOnly = w2.repo('a3-list-flags-fallback');
    wt.writeFlowHome(w2.home, { name: 'fallback', stepIds: ['fb1'] });
    expect(offeredToRecovery({ worktreeDir: fallbackOnly, globalRoot: w2.home })).toEqual(['fallback']);
  });
});

describe('listCatalog — an entry that exists but cannot be selected (§18.7.6)', () => {
  it('lists an escaping repo entry as unavailable from its own tier with the refusal reason, never falling through to the global one', () => {
    const w = world();
    const repo = w.repo('a3-list-escapes');
    catalog.addEntryWithSteps(flowCatalogDir(w.home), 'dual', ['g1']);
    catalog.addEntryWithSteps(flowCatalogDir(repo), 'dual', ['r1']);
    catalog.symlinkEntryFlowYaml(flowCatalogDir(repo), 'dual');

    const listing = listCatalog({ worktreeDir: repo, globalRoot: w.home });
    expect(listing.entries).toEqual([
      { available: false, label: 'dual', origin: 'repo', reason: catalogRefusalReason('escapes') },
    ]);
    expect(offeredToRecovery({ worktreeDir: repo, globalRoot: w.home })).toEqual(['global:dual']);
  });
});

describe('catalogListResult — the flow:listCatalog answer (§18.7.6)', () => {
  it('wraps a listing as ok', () => {
    const listing: FlowCatalogListing = { entries: [], tierNotices: [], selection: { kind: 'unset' }, recoveryOutcomes: [] };
    expect(catalogListResult(() => listing)).toEqual({ ok: true, listing });
  });

  it('turns a listing failure into a display-sanitized, length-bounded reason', () => {
    const result = catalogListResult(() => {
      throw new Error(`EACCES /tmp/bad\u202Edir\u200B${'y'.repeat(400)}`);
    });
    expect(result.ok).toBe(false);
    const reason = result.ok ? '' : result.reason;
    expect(reason).toMatch(/^Could not list flows: EACCES/);
    expect(reason).not.toMatch(/[\u202E\u200B]/u);
    expect(reason.length).toBeLessThanOrEqual(MAX_ECHOED_REASON_LENGTH);
  });
});

const nameOf = (e: FlowCatalogListing['entries'][number]): string => (e.available ? e.id : e.label);
const HOSTILE = /[\u202E\u200B\u0000-\u001F]/u;

/** The listing as `flow:listCatalog` answers it: an unreadable tier is a notice inside a listing, never a failure. */
function listed(roots: { worktreeDir: string; globalRoot: string }): FlowCatalogListing {
  const result = catalogListResult(() => listCatalog(roots));
  expect(result, 'an unreadable tier still yields a listing').toMatchObject({ ok: true });
  if (!result.ok) throw new Error(result.reason);
  return result.listing;
}

describe('listCatalog — tier notices, unreadable vs empty vs absent (AC9)', () => {
  it('an unreadable repo tier yields a repo notice and lists the global entries unavailable with the repo-tier reason', () => {
    const w = world();
    const repo = w.repo('a3-list-unreadable-repo');
    catalog.addEntryWithSteps(flowCatalogDir(w.home), 'g-one', ['g1']);
    catalog.addEntryWithSteps(flowCatalogDir(w.home), 'g-two', ['g1']);
    catalog.makeUnreadableTier(repo);
    const roots = { worktreeDir: repo, globalRoot: w.home };

    const listing = listed(roots);
    expect(listing.tierNotices.map((n) => n.origin)).toEqual(['repo']);
    expect(listing.tierNotices[0]!.notice).toMatch(/\S/);
    expect(listing.entries.map(nameOf).sort()).toEqual(['g-one', 'g-two']);
    for (const e of listing.entries) {
      if (e.available) throw new Error(`${e.id} is selectable past an unreadable repo tier`);
      expect(e.reason, e.label).toBe(catalogRefusalReason('unresolvable'));
    }
  });

  it.skipIf(process.getuid?.() === 0)('a repo tier directory that exists but denies reading yields a repo notice, not a failed listing', () => {
    const w = world();
    const repo = w.repo('a3-list-eacces-repo');
    catalog.addEntryWithSteps(flowCatalogDir(w.home), 'g-one', ['g1']);
    mkdirSync(flowCatalogDir(repo), { recursive: true });
    chmodSync(flowCatalogDir(repo), 0o000);
    try {
      const roots = { worktreeDir: repo, globalRoot: w.home };
      const listing = listed(roots);
      expect(listing.tierNotices.map((n) => n.origin)).toEqual(['repo']);
      expect(listing.entries.map(nameOf)).toEqual(['g-one']);
      const verdict = resolveCatalogEntry(roots, 'g-one');
      expect(listing.entries[0]!.available, 'the listing offers g-one exactly when a run could resolve it').toBe(verdict.ok);
    } finally {
      chmodSync(flowCatalogDir(repo), 0o755);
    }
  });

  it('a repo with no .agent-terminal at all yields no notice and leaves the global entries selectable', () => {
    const w = world();
    const repo = w.repo('a3-list-absent-repo');
    catalog.addEntryWithSteps(flowCatalogDir(w.home), 'g-one', ['g1']);
    rmSync(flowHomeDir(repo), { recursive: true, force: true });
    expect(existsSync(flowHomeDir(repo)), 'the fixture repo has no .agent-terminal').toBe(false);

    const listing = listed({ worktreeDir: repo, globalRoot: w.home });
    expect(listing.tierNotices).toEqual([]);
    expect(availableIds(listing)).toEqual(['global:g-one']);
  });

  it('an empty repo tier yields no notice and leaves the global entries selectable', () => {
    const w = world();
    const repo = w.repo('a3-list-empty-repo');
    catalog.addEntryWithSteps(flowCatalogDir(w.home), 'g-one', ['g1']);
    mkdirSync(flowCatalogDir(repo), { recursive: true });

    const listing = listed({ worktreeDir: repo, globalRoot: w.home });
    expect(listing.tierNotices).toEqual([]);
    expect(availableIds(listing)).toEqual(['global:g-one']);
  });

  it('an unreadable global tier yields a global notice and leaves the repo entries selectable', () => {
    const w = world();
    const repo = w.repo('a3-list-unreadable-global');
    catalog.addEntryWithSteps(flowCatalogDir(repo), 'r-one', ['r1']);
    catalog.makeUnreadableTier(w.home);

    const listing = listed({ worktreeDir: repo, globalRoot: w.home });
    expect(listing.tierNotices.map((n) => n.origin)).toEqual(['global']);
    expect(availableIds(listing)).toEqual(['repo:r-one']);
  });

  it('a first-run global home lists the repo entries with no notice and no global fallback', () => {
    const w = world();
    const repo = w.repo('a3-list-first-run');
    catalog.addEntryWithSteps(flowCatalogDir(repo), 'r-one', ['r1']);
    catalog.removeGlobalHome(w.home);

    const listing = listed({ worktreeDir: repo, globalRoot: w.home });
    expect(listing.tierNotices).toEqual([]);
    expect(availableIds(listing)).toEqual(['repo:r-one']);
    expect(offeredToRecovery({ worktreeDir: repo, globalRoot: w.home })).not.toContain('fallback');
  });

  it("a tier notice over a path planted with bidi and zero-width characters is display-sanitized and bounded", () => {
    const w = world();
    const repo = w.repo(`a3-list-\u202Ehostile\u200B-${'p'.repeat(MAX_ECHOED_REASON_LENGTH)}`);
    catalog.addEntryWithSteps(flowCatalogDir(w.home), 'g-one', ['g1']);
    catalog.makeUnreadableTier(repo);

    const listing = listed({ worktreeDir: repo, globalRoot: w.home });
    expect(listing.tierNotices).toHaveLength(1);
    const notice = listing.tierNotices[0]!.notice;
    expect(notice).not.toMatch(HOSTILE);
    expect(notice.length).toBeLessThanOrEqual(MAX_ECHOED_REASON_LENGTH);
  });
});

describe('listCatalog — unsafe names and tier confinement (§18.7.6, CWE-22/59/400)', () => {
  it('lists a member whose name is not a safe flow id as unavailable, with a display-safe label and the invalid-id reason', () => {
    const w = world();
    const repo = w.repo('a3-list-unsafe');
    catalog.addEntryWithSteps(flowCatalogDir(w.home), 'fine', ['g1']);
    catalog.addEntryWithSteps(flowCatalogDir(w.home), 'Bad\u202Ename\u200B', ['g1']);
    catalog.addEntryWithSteps(flowCatalogDir(w.home), `Long\u202E${'x'.repeat(200)}`, ['g1']);

    const listing = listed({ worktreeDir: repo, globalRoot: w.home });
    expect(availableIds(listing)).toEqual(['global:fine']);
    const unsafe = listing.entries.flatMap((e) => (e.available ? [] : [e]));
    expect(unsafe).toHaveLength(2);
    const row = unsafe.find((e) => e.label.includes('Bad'));
    if (!row) throw new Error('the unsafe "Bad…" member is not listed');
    expect(row.origin).toBe('global');
    expect(row.label).not.toMatch(HOSTILE);
    expect(row.reason).toMatch(/not a valid flow id/i);
    const long = unsafe.find((e) => e.label.includes('Long'));
    if (!long) throw new Error('the over-long unsafe member is not listed');
    expect(long.label).not.toMatch(HOSTILE);
    expect(long.label, 'an over-long unsafe name is truncated').not.toContain('x'.repeat(MAX_CATALOG_ID_LENGTH + 1));
  });

  it.each([
    ['a zero-width character', 'fine', 'fine\u200D'],
    ['truncation', 'a'.repeat(MAX_CATALOG_ID_LENGTH), 'a'.repeat(MAX_CATALOG_ID_LENGTH + 6)],
  ])('an unsafe name that %s would make look like a real flow id is never labelled as that id', (_how, real, unsafeName) => {
    const w = world();
    const repo = w.repo('a3-list-unsafe-lookalike');
    catalog.addEntryWithSteps(flowCatalogDir(w.home), real, ['g1']);
    catalog.addEntryWithSteps(flowCatalogDir(repo), unsafeName, ['r1']);

    const listing = listed({ worktreeDir: repo, globalRoot: w.home });
    expect(availableIds(listing)).toEqual([`global:${real}`]);
    const labels = listing.entries.flatMap((e) => (e.available ? [] : [e.label]));
    expect(labels).toHaveLength(1);
    expect(labels[0]).not.toBe(real);
  });

  it('lists two distinct unsafe names that display alike as two rows', () => {
    const w = world();
    const repo = w.repo('a3-list-unsafe-alike');
    catalog.addEntryWithSteps(flowCatalogDir(w.home), 'Bad\u200Cname', ['g1']);
    catalog.addEntryWithSteps(flowCatalogDir(w.home), 'Bad\u200Dname', ['g1']);

    const listing = listed({ worktreeDir: repo, globalRoot: w.home });
    expect(listing.entries.filter((e) => !e.available)).toHaveLength(2);
  });

  it('lists an unsafe name present in both tiers once, from the repo tier (§18.1 merged library, repo wins)', () => {
    const w = world();
    const repo = w.repo('a3-list-unsafe-both');
    catalog.addEntryWithSteps(flowCatalogDir(w.home), 'Bad_name', ['g1']);
    catalog.addEntryWithSteps(flowCatalogDir(repo), 'Bad_name', ['r1']);

    const listing = listed({ worktreeDir: repo, globalRoot: w.home });
    const unsafe = listing.entries.filter((e) => !e.available);
    expect(unsafe.map((e) => e.origin)).toEqual(['repo']);
  });

  it('never lists a plain file in a tier, whatever its name', () => {
    const w = world();
    const repo = w.repo('a3-list-stray-files');
    catalog.addEntryWithSteps(flowCatalogDir(repo), 'r-one', ['r1']);
    catalog.fileCatalogMember(flowCatalogDir(repo), '.DS_Store');
    catalog.fileCatalogMember(flowCatalogDir(repo), 'Read\u202Eme');
    catalog.fileCatalogMember(flowCatalogDir(repo), 'stray');

    const listing = listed({ worktreeDir: repo, globalRoot: w.home });
    expect(listing.entries.map(nameOf)).toEqual(['r-one']);
  });

  it.each([
    ['.agent-terminal/flows', (repo: string, outside: string, _scratch: string) => {
      mkdirSync(flowHomeDir(repo), { recursive: true });
      symlinkSync(outside, flowCatalogDir(repo));
    }],
    ['.agent-terminal', (repo: string, outside: string, scratch: string) => {
      const home = join(scratch, 'home');
      mkdirSync(home);
      symlinkSync(outside, join(home, 'flows'));
      wt.plantAgentTerminalDirEscape(repo, home);
    }],
  ])('a repo whose %s is a symlink out of the worktree lists no name from the link target, and shows a repo notice', (_label, plant) => {
    const w = world();
    const repo = w.repo('a3-list-tier-escape');
    const outside = mkdtempSync(join(tmpdir(), 'a3-list-outside-'));
    const scratch = mkdtempSync(join(tmpdir(), 'a3-list-outside-home-'));
    catalog.addEntryWithSteps(outside, 'sentinel-outside-name', ['x1']);
    catalog.addEntryWithSteps(flowCatalogDir(w.home), 'g-one', ['g1']);
    try {
      plant(repo, outside, scratch);
      const listing = listed({ worktreeDir: repo, globalRoot: w.home });
      expect(listing.entries.map(nameOf)).not.toContain('sentinel-outside-name');
      expect(offeredToRecovery({ worktreeDir: repo, globalRoot: w.home }).join(' ')).not.toContain('sentinel-outside-name');
      expect(listing.tierNotices.map((n) => n.origin)).toContain('repo');
    } finally {
      rmSync(outside, { recursive: true, force: true });
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('lists a tier of exactly MAX_CATALOG_LIST_MEMBERS members in full, with no truncation notice', () => {
    const w = world();
    const repo = w.repo('a3-list-at-cap');
    const tier = flowCatalogDir(repo);
    for (let i = 0; i < MAX_CATALOG_LIST_MEMBERS; i++) catalog.addEntryWithSteps(tier, `m-${String(i).padStart(6, '0')}`, ['s1']);

    const listing = listed({ worktreeDir: repo, globalRoot: w.home });
    expect(listing.entries.filter((e) => e.origin === 'repo')).toHaveLength(MAX_CATALOG_LIST_MEMBERS);
    expect(listing.tierNotices).toEqual([]);
  });

  it('does not count stray files against MAX_CATALOG_LIST_MEMBERS', () => {
    const w = world();
    const repo = w.repo('a3-list-at-cap-strays');
    const tier = flowCatalogDir(repo);
    for (let i = 0; i < MAX_CATALOG_LIST_MEMBERS; i++) catalog.addEntryWithSteps(tier, `m-${String(i).padStart(6, '0')}`, ['s1']);
    catalog.fileCatalogMember(tier, '.DS_Store');
    catalog.fileCatalogMember(tier, 'README.md');

    const listing = listed({ worktreeDir: repo, globalRoot: w.home });
    expect(listing.entries.filter((e) => e.origin === 'repo')).toHaveLength(MAX_CATALOG_LIST_MEMBERS);
    expect(listing.tierNotices).toEqual([]);
  });

  it('bounds a tier with more than MAX_CATALOG_LIST_MEMBERS members and says the list was truncated', () => {
    const w = world();
    const repo = w.repo('a3-list-over-cap');
    const tier = flowCatalogDir(repo);
    for (let i = 0; i <= MAX_CATALOG_LIST_MEMBERS; i++) catalog.addEntryWithSteps(tier, `m-${String(i).padStart(6, '0')}`, ['s1']);

    const listing = listed({ worktreeDir: repo, globalRoot: w.home });
    expect(listing.entries.filter((e) => e.origin === 'repo')).toHaveLength(MAX_CATALOG_LIST_MEMBERS);
    expect(listing.tierNotices.filter((n) => n.origin === 'repo').map((n) => n.notice).join(' ')).toMatch(/truncated/i);
  });
});
