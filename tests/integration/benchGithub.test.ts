import { afterEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { createBenchFixtureBuilder, type BenchFixtureBuilder } from '../helpers/benchFixtureBuilder';
import { seedFakeGhGit } from '../e2e/fakeTools';
import { createBenchGithub } from '../../src/main/benchGithub';

// #180 — the real BenchGithub against the PATH-first fake `gh`, over real git.

let b: BenchFixtureBuilder;
const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  b?.cleanup();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('the real BenchGithub', () => {
  it('names the GitHub repository a folder belongs to by its selector', async () => {
    b = createBenchFixtureBuilder();
    const { dir } = b.makeRepository('bench-gh-repo');
    const { binDir, ghOnlyBinDir, logFile } = seedFakeGhGit('bench-gh-');
    dirs.push(binDir);
    vi.stubEnv('PATH', `${ghOnlyBinDir}:${process.env.PATH}`);
    vi.stubEnv('FAKE_GHGIT_LOG', logFile);

    expect(await createBenchGithub().repositoryOf(dir)).toBe('github.com/fake/repo');
  });
});
