import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { discover, gitRootOf, warmBaseRef } from '../../src/main/artifactTree';
import type { ArtifactNode } from '../../src/shared/ipc/viewer';
import { createAdoptionWorld, type AdoptionWorld, type AdoptionWorldOptions } from '../helpers/adoptionWorld';

// §20.1 — the artifact tree's base comes from the current branch's own pull request on origin's repository: the
// real `gh` read, run against the adoption world's gh stand-in, which refuses any call that does not name the
// repository.

const worlds: AdoptionWorld[] = [];
afterEach(() => {
  for (const w of worlds.splice(0)) w.dispose();
});

/** A world whose PR is stacked on `parent`, with the operator's clone on a branch named like the PR's head. */
function world(pr: AdoptionWorldOptions['pr'] = {}): AdoptionWorld {
  const w = createAdoptionWorld({ prefix: 'pr-base-warm', pr: { stackedOn: 'parent', ...pr } });
  worlds.push(w);
  w.activate();
  w.git(w.repo, ['fetch', '-q', 'origin']);
  w.git(w.repo, ['fetch', '-q', 'origin', `refs/pull/${w.prNumber}/head`]);
  w.git(w.repo, ['checkout', '-q', '-b', w.headBranch, 'FETCH_HEAD']);
  return w;
}

/** The repository root the app warms, as `createBaseWarmer` resolves it. */
const root = (w: AdoptionWorld): string => gitRootOf(w.repo) ?? w.repo;

const flat = (nodes: ArtifactNode[]): ArtifactNode[] => nodes.flatMap((n) => [n, ...flat(n.children ?? [])]);
/** The files the artifact tree tags as the PR's: the head's commits past the base the warm took. On a head stacked
 *  on `parent`, the right base leaves only the PR's own change; `main` would add the parent's, the head none. */
const prFiles = (w: AdoptionWorld): string[] =>
  flat(discover(w.repo, 'curated').nodes).filter((n) => n.provenance?.includes('pr')).map((n) => n.relPath);

const git = (args: string[], cwd: string): string => execFileSync('git', args, { cwd, encoding: 'utf8' });

describe("warmBaseRef — the current branch's own PR base, read from origin's repository", () => {
  it("takes the open PR's base branch", async () => {
    const w = world();
    expect.soft(await warmBaseRef(root(w), { git })).toBe(true);
    expect.soft(prFiles(w)).toEqual(['change.txt']);
    expect.soft(w.contractBreaches()).toEqual([]);
  });

  it('still takes the base of a PR that is already merged', async () => {
    const w = world({ state: 'MERGED' });
    expect.soft(await warmBaseRef(root(w), { git })).toBe(true);
    expect.soft(prFiles(w)).toEqual(['change.txt']);
    expect.soft(w.contractBreaches()).toEqual([]);
  });

  it("never takes a fork's PR whose head branch only shares the name", async () => {
    const w = world({ fork: 'contributor/fork' });
    expect.soft(await warmBaseRef(root(w), { git })).toBe(false);
    expect.soft(w.contractBreaches()).toEqual([]);
  });

  it("takes the base of the operator's own PR from the fork origin pushes to", async () => {
    const w = world({ fork: 'contributor/fork' });
    w.git(w.repo, ['config', 'remote.origin.pushurl', 'https://github.com/Contributor/fork.git']);
    expect.soft(await warmBaseRef(root(w), { git })).toBe(true);
    expect.soft(prFiles(w)).toEqual(['change.txt']);
    expect.soft(w.contractBreaches()).toEqual([]);
  });
});
