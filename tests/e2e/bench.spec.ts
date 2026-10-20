import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createBenchFixtureBuilder, type BenchFixtureBuilder } from '../helpers/benchFixtureBuilder';
import { seedFakeGhGit } from './fakeTools';
import { BENCH_ENTRY } from '../../src/main/benchMain';
import { BENCH_FIXTURE_MANIFEST, parseBenchFixture, type BenchFixtureRead } from '../../src/shared/benchFixture';
import { createFlowStateStore } from '../../src/main/flowState';
import { APP_HOME_DIR_ENV } from '../../src/main/launchRoot';

// #180 — the built runner entry, run the way the `bench` script runs it: this checkout's electron in plain-Node
// mode on `out/main/<BENCH_ENTRY>.js`, argv only, temp homes, INIT_CWD naming the invoking directory, the gh-only
// fake first on PATH and real git.

const V3_FLOW = readFileSync(join(process.cwd(), 'example', 'flows', 'feature-dev-v3', 'flow.yaml'), 'utf8');
const electronBinary = createRequire(join(process.cwd(), 'package.json'))('electron') as string;

let b: BenchFixtureBuilder | undefined;
const dirs: string[] = [];
test.afterEach(() => {
  b?.cleanup();
  b = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const temp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  dirs.push(dir);
  return dir;
};

test('the bench script runs the built runner entry', { tag: '@ownapp' }, () => {
  const scripts = (JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;
  expect(scripts.bench ?? '').toContain(`out/main/${BENCH_ENTRY}.js`);
});

test('capture through the built entry writes a fixture the shared reader reads back', { tag: '@ownapp' }, () => {
  b = createBenchFixtureBuilder();
  const { dir: wf, commit } = b.makeRepository('bench-e2e-capture');
  b.seedFlow(wf, 'feature-dev-v3', V3_FLOW);
  createFlowStateStore(wf).write({ step: 'plan', status: 'not_started', inputs: { ticket: '180' } });
  b.writeArtifacts(wf, { 'groomed-ticket.md': '# groomed\n' });
  const { binDir, ghOnlyBinDir, logFile } = seedFakeGhGit('bench-e2e-gh-');
  dirs.push(binDir);
  const invoking = temp('bench-e2e-invoking');

  const run = spawnSync(electronBinary, [join(process.cwd(), 'out', 'main', `${BENCH_ENTRY}.js`), 'capture', relative(invoking, wf), 'fx'], {
    encoding: 'utf8',
    env: {
      PATH: `${ghOnlyBinDir}:${process.env.PATH}`,
      FAKE_GHGIT_LOG: logFile,
      ELECTRON_RUN_AS_NODE: '1',
      HOME: temp('bench-e2e-home'),
      [APP_HOME_DIR_ENV]: temp('bench-e2e-app-home'),
      CLAUDE_CONFIG_DIR: temp('bench-e2e-claude'),
      INIT_CWD: invoking,
      GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
      GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM,
    },
  });

  const manifest = join(invoking, 'fx', BENCH_FIXTURE_MANIFEST);
  const read: BenchFixtureRead | null = existsSync(manifest) ? parseBenchFixture(readFileSync(manifest, 'utf8')) : null;
  expect({ read, exit: run.status, output: `${run.stdout}${run.stderr}` }).toEqual({
    read: {
      ok: true,
      fixture: { schema_version: 1, commit, issue: { repository: 'github.com/fake/repo', number: 180 }, inputs: {}, repeat_counts: {} },
    },
    exit: 0,
    output: expect.any(String),
  });
});
