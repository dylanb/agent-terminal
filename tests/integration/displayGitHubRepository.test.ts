import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGithubRefs } from '../../src/main/githubRefs';
import { readPrBaseName } from '../../src/main/artifactTree';
import { displayGitHubRepository } from '../../src/main/githubRepository';
import { installPathGitStub } from '../helpers/pathGitStub';
import { shellQuote } from '../../src/shared/shellQuote';

const cleanup: string[] = [];
const originalPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = originalPath;
  while (cleanup.length > 0) rmSync(cleanup.pop()!, { recursive: true, force: true });
});

/** A checkout on branch `feature`, with the given remotes, and a `gh` that answers only for `answers`' repository. */
function checkout(remotes: Record<string, string>, answers: string): string {
  const repo = mkdtempSync(join(tmpdir(), 'display-repo-'));
  const bin = mkdtempSync(join(tmpdir(), 'display-repo-bin-'));
  cleanup.push(repo, bin);
  execFileSync('git', ['init', '-q', '-b', 'feature'], { cwd: repo });
  for (const [name, url] of Object.entries(remotes)) execFileSync('git', ['remote', 'add', name, url], { cwd: repo });
  writeFileSync(
    join(bin, 'gh'),
    '#!/usr/bin/env bash\n' +
      `[ "$4" = "--repo" ] && [ "$5" = "${answers}" ] || exit 1\n` +
      'if [ "$1" = "issue" ] && [ "$3" = "25" ]; then printf \'{"title":"Export button","body":"","url":"https://github.com/x/y/issues/25"}\\n\'; exit 0; fi\n' +
      'if [ "$1" = "pr" ] && [ "$3" = "contributor:feature" ]; then printf \'{"baseRefName":"release"}\\n\'; exit 0; fi\n' +
      'if [ "$1" = "pr" ] && [ "$3" = "feature" ]; then printf \'{"baseRefName":"develop"}\\n\'; exit 0; fi\n' +
      'exit 1\n',
    { mode: 0o755 },
  );
  process.env.PATH = `${bin}:${originalPath ?? ''}`;
  return repo;
}

const FORK = 'https://github.com/contributor/project.git';
const REAL = 'https://github.com/owner/project.git';

describe("the display reads ask the repository gh would: upstream's when there is one, else origin's (#304)", () => {
  it('in a fork checkout, reads the ticket title and the PR base from upstream, the PR head being the fork owner\'s branch', async () => {
    const repo = checkout({ origin: FORK, upstream: REAL }, 'github.com/owner/project');

    expect((await createGithubRefs()(repo, 'issue', 25))?.title).toBe('Export button');
    expect(await readPrBaseName(repo)).toBe('release');
  });

  it("without an upstream remote, reads them from origin's repository", async () => {
    const repo = checkout({ origin: REAL }, 'github.com/owner/project');

    expect((await createGithubRefs()(repo, 'issue', 25))?.title).toBe('Export button');
    expect(await readPrBaseName(repo)).toBe('develop');
  });

  it("reads from origin when upstream does not name a GitHub repository", async () => {
    const repo = checkout({ origin: REAL, upstream: 'file:///srv/mirror.git' }, 'github.com/owner/project');

    expect((await createGithubRefs()(repo, 'issue', 25))?.title).toBe('Export button');
  });
});

describe("the upstream lookup under the repository's own git config (#304)", () => {
  it('reads the upstream remote with the shared hooks-path and fsmonitor overrides', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'display-repo-hardened-'));
    const log = join(mkdtempSync(join(tmpdir(), 'display-repo-log-')), 'git.log');
    cleanup.push(repo, dirname(log));
    execFileSync('git', ['init', '-q', '-b', 'feature'], { cwd: repo });
    execFileSync('git', ['remote', 'add', 'origin', FORK], { cwd: repo });
    execFileSync('git', ['remote', 'add', 'upstream', REAL], { cwd: repo });
    const stub = installPathGitStub([{ argvPrefix: [], script: `printf '%s\\n' "$*" >> ${shellQuote(log)}` }]);
    try {
      expect((await displayGitHubRepository(repo)).selector).toBe('github.com/owner/project');
      const reads = readFileSync(log, 'utf8').split('\n').filter((l) => l.includes('remote.upstream.url'));
      expect(reads.length).toBeGreaterThan(0);
      expect(reads.filter((l) => !/core\.hooksPath=/.test(l) || !/core\.fsmonitor=false/.test(l))).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
      stub.dispose();
    }
  });
});
