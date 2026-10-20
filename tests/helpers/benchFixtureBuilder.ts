// Real-git fixtures for the bench runner (#180): the invoking repository a capture or run starts from, a flow
// installed the way the app reads it, the loop artifacts, and the symlink shapes the confinement refusals
// meet. Every path comes from the app's own resolvers; state the app writes (flow-state, phase baseline) is
// seeded with its own writers (createFlowStateStore, recordBaselineCommit), which tests call directly.

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createGitRepoFixture } from './gitRepo';
import { catalogEntryDefFile } from '../../src/main/flow';
import { writeActiveFlow } from '../../src/main/activeFlowPointer';
import { APP_LOOP_DIR_SEGMENTS, ARTIFACTS_SUBDIR } from '../../src/main/appLoopPaths';
import { BENCH_FIXTURE_ARTIFACTS, BENCH_FIXTURE_MANIFEST, EXAMPLE_BENCH_FIXTURE } from '../../src/shared/benchFixture';

/** The origin every builder repository has: the repository the fake `gh`'s `repo view` describes. */
export const FAKE_ORIGIN_URL = 'https://github.com/fake/repo.git';

export interface BenchFixtureBuilder {
  /** A repository on `main` with origin FAKE_ORIGIN_URL, a `.gitignore` that ignores `.agent-terminal/` (so a
   *  commit carries none, as in a real repository), and one commit, whose id it returns. */
  makeRepository(prefix: string): { dir: string; commit: string };
  /** Install `flowYaml` as the repo-tier catalog entry `id` and point the active-flow pointer at it. */
  seedFlow(dir: string, id: string, flowYaml: string): void;
  /** Write each `relPath → contents` under the folder's loop artifacts directory. */
  writeArtifacts(dir: string, files: Record<string, string>): void;
  /** Commit `rel` as a symlink to `target`, forced past `.gitignore`; returns the new commit. */
  commitTrackedSymlink(repo: string, rel: string, target: string): string;
  /** A symlink at `link` to a new file outside every tree, holding `sentinel`. */
  plantEscapeLink(link: string): { outsideFile: string; sentinel: string };
  /** A fixture folder an operator wrote by hand: the documented example's manifest with `fields` over it (an
   *  `undefined` field leaves that key out), and `artifacts` beside it. */
  writeHandFixture(fixtureDir: string, fields: Record<string, unknown>, artifacts: Record<string, string>): void;
  /** A temp dir outside every tree. */
  outsideDir(prefix: string): string;
  writeRepoFile(dir: string, relPath: string, contents: string): void;
  commitAll(dir: string, message: string): string;
  git(dir: string, args: string[]): string;
  cleanup(): void;
}

export function createBenchFixtureBuilder(): BenchFixtureBuilder {
  const repos = createGitRepoFixture();
  const tracked: string[] = [];
  const outsideDir = (prefix: string): string => {
    const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
    tracked.push(dir);
    return dir;
  };
  const write = (file: string, contents: string): void => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents);
  };

  return {
    makeRepository(prefix) {
      const dir = repos.makeGitRepo(prefix);
      repos.git(dir, ['remote', 'add', 'origin', FAKE_ORIGIN_URL]);
      repos.writeRepoFile(dir, '.gitignore', '.agent-terminal/\n');
      repos.writeRepoFile(dir, 'README.md', '# fixture\n');
      return { dir, commit: repos.commitAll(dir, 'fixture base') };
    },
    seedFlow(dir, id, flowYaml) {
      write(catalogEntryDefFile(dir, id), flowYaml);
      writeActiveFlow(dir, id);
    },
    writeArtifacts(dir, files) {
      for (const [rel, contents] of Object.entries(files)) write(join(dir, ...APP_LOOP_DIR_SEGMENTS, ARTIFACTS_SUBDIR, rel), contents);
    },
    commitTrackedSymlink(repo, rel, target) {
      const link = join(repo, rel);
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(target, link);
      repos.git(repo, ['add', '-f', '--', rel]);
      repos.git(repo, ['commit', '-q', '-m', `track ${rel} as a symlink`]);
      return repos.git(repo, ['rev-parse', 'HEAD']);
    },
    plantEscapeLink(link) {
      const outsideFile = join(outsideDir('bench-escape-target'), 'secret.md');
      const sentinel = 'outside the tree\n';
      writeFileSync(outsideFile, sentinel);
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(outsideFile, link);
      return { outsideFile, sentinel };
    },
    writeHandFixture(fixtureDir, fields, artifacts) {
      write(join(fixtureDir, BENCH_FIXTURE_MANIFEST), `${JSON.stringify({ ...EXAMPLE_BENCH_FIXTURE, ...fields }, null, 2)}\n`);
      for (const [rel, contents] of Object.entries(artifacts)) write(join(fixtureDir, BENCH_FIXTURE_ARTIFACTS, rel), contents);
    },
    outsideDir,
    writeRepoFile: repos.writeRepoFile,
    commitAll: repos.commitAll,
    git: repos.git,
    cleanup() {
      repos.cleanup();
      while (tracked.length) rmSync(tracked.pop()!, { recursive: true, force: true });
    },
  };
}
