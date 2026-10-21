import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createBenchFixtureBuilder, type BenchFixtureBuilder } from '../helpers/benchFixtureBuilder';
import { seedFakeGhGit, seedFakeGhIssue } from './fakeTools';
import { BENCH_ENTRY } from '../../src/main/benchMain';
import { benchAppTarget, benchLaunchEnv } from '../../src/main/benchLauncher';
import { BENCH_LAUNCH_SCHEMA } from '../../src/shared/benchLaunch';
import { BENCH_FIXTURE_MANIFEST, parseBenchFixture, type BenchFixtureRead } from '../../src/shared/benchFixture';
import { createFlowStateStore } from '../../src/main/flowState';
import { APP_HOME_DIR_ENV, APP_LAUNCH_DIR_ENV } from '../../src/main/launchRoot';

// #180 — the built runner entry, run the way the `bench` script runs it: this checkout's electron in plain-Node
// mode on `out/main/<BENCH_ENTRY>.js`, argv only, temp homes, INIT_CWD naming the invoking directory, the gh-only
// fake first on PATH and real git; and the app the runner launches, opened the way its launcher opens it.

const V3_FLOW = readFileSync(join(process.cwd(), 'example', 'flows', 'feature-dev-v3', 'flow.yaml'), 'utf8');
const electronBinary = createRequire(join(process.cwd(), 'package.json'))('electron') as string;
const BUILT_APP_MAIN = join(process.cwd(), 'out', 'main', 'index.js');

let b: BenchFixtureBuilder | undefined;
let app: ElectronApplication | undefined;
const dirs: string[] = [];
test.afterEach(async () => {
  await app?.close();
  app = undefined;
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

interface EntryCommand {
  argv: string[];
  env: NodeJS.ProcessEnv;
  /** The log of the fake `gh` first on the entry's PATH, which also keys its issue store. */
  ghLog: string;
}

/** The built entry as the `bench` script runs it, from `invoking`, under temp homes, with `base` beneath. */
function entryCommand(args: string[], invoking: string, appHome: string, base: NodeJS.ProcessEnv = {}): EntryCommand {
  const { binDir, ghOnlyBinDir, logFile } = seedFakeGhGit('bench-e2e-gh-');
  dirs.push(binDir);
  return {
    argv: [join(process.cwd(), 'out', 'main', `${BENCH_ENTRY}.js`), ...args],
    env: {
      ...base,
      PATH: `${ghOnlyBinDir}:${process.env.PATH}`,
      FAKE_GHGIT_LOG: logFile,
      ELECTRON_RUN_AS_NODE: '1',
      HOME: temp('bench-e2e-home'),
      [APP_HOME_DIR_ENV]: appHome,
      CLAUDE_CONFIG_DIR: temp('bench-e2e-claude'),
      INIT_CWD: invoking,
      GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
      GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM,
    },
    ghLog: logFile,
  };
}

function runEntry(args: string[], invoking: string, appHome: string): ReturnType<typeof spawnSync> {
  const cmd = entryCommand(args, invoking, appHome);
  return spawnSync(electronBinary, cmd.argv, { encoding: 'utf8', env: cmd.env });
}

/** The pid, argv and launch dir of each process, other than Chromium's own children, whose env names a folder under
 *  `root`: the launched app and whatever it spawned with its env. */
function appsLaunchedUnder(root: string): { pid: number; args: string[]; launchDir: string }[] {
  const found: { pid: number; args: string[]; launchDir: string }[] = [];
  for (const name of readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
    try {
      const args = readFileSync(join('/proc', name, 'cmdline'), 'utf8').split('\0');
      if (args.some((a) => a.startsWith('--type='))) continue;
      const launchDir = readFileSync(join('/proc', name, 'environ'), 'utf8')
        .split('\0')
        .find((e) => e.startsWith(`${APP_LAUNCH_DIR_ENV}=`))
        ?.slice(APP_LAUNCH_DIR_ENV.length + 1);
      if (launchDir?.startsWith(`${root}/`)) found.push({ pid: Number(name), args, launchDir });
    } catch {
      continue;
    }
  }
  return found;
}

function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig);
  } catch {
    return;
  }
}

test('run through the built entry refuses an unparsable fixture with its code and creates no run folder', { tag: '@ownapp' }, () => {
  b = createBenchFixtureBuilder();
  const { dir: repo } = b.makeRepository('bench-e2e-run');
  b.seedFlow(repo, 'feature-dev-v3', V3_FLOW);
  const fixture = join(temp('bench-e2e-fx'), 'fx');
  b.writeHandFixture(fixture, {}, {});
  writeFileSync(join(fixture, BENCH_FIXTURE_MANIFEST), '{ "schema_version": 1, ');
  const appHome = temp('bench-e2e-app-home');

  const run = runEntry(['run', '--flow', 'feature-dev-v3', '--span', 'plan', '--fixture', fixture, '--runs', '1'], repo, appHome);

  const output = `${run.stdout}${run.stderr}`;
  expect({ failed: run.status !== 0, namesCode: output.includes('fixture-unparsable'), appHome: readdirSync(appHome), output }).toEqual({
    failed: true,
    namesCode: true,
    appHome: [],
    output: expect.any(String),
  });
});

test('run through the built entry opens the app at the prepared folder, waits for it to exit, and prints its run folder', { tag: '@ownapp' }, async () => {
  test.skip(process.platform !== 'linux', 'reads the launched app from /proc: the Podman harness');
  b = createBenchFixtureBuilder();
  const { dir: repo, commit } = b.makeRepository('bench-e2e-run-launch');
  b.seedFlow(repo, 'feature-dev-v3', V3_FLOW);
  const fixture = join(temp('bench-e2e-run-launch-fx'), 'fx');
  b.writeHandFixture(fixture, { commit, phase_baseline: undefined, issue: { repository: 'github.com/fake/repo', number: 180 } }, { 'groomed-ticket.md': '# groomed\n' });
  const appHome = realpathSync(temp('bench-e2e-run-launch-app-home'));
  const cmd = entryCommand(['run', '--flow', 'feature-dev-v3', '--span', 'plan', '--fixture', fixture, '--runs', '1'], repo, appHome, { ...process.env, APP_SHELL: 'bash' });
  seedFakeGhIssue(cmd.ghLog, { number: 180, title: 'Bench-1', body: 'The intent.\n', labels: ['agent-loop/ready'], comments: [] });

  const runner = spawn(electronBinary, cmd.argv, { env: cmd.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  runner.stdout.on('data', (d: Buffer) => (output += d.toString()));
  runner.stderr.on('data', (d: Buffer) => (output += d.toString()));
  const exited = new Promise<number | null>((done) => runner.on('exit', (code) => done(code)));
  let runnerExit: number | null | undefined;
  void exited.then((code) => (runnerExit = code));

  let launched: { pid: number; args: string[]; launchDir: string }[] = [];
  let runnerWaiting = false;
  let exit: number | null | 'still running';
  try {
    for (const deadline = Date.now() + 20_000; launched.length === 0 && runnerExit === undefined && Date.now() < deadline; ) {
      await new Promise((r) => setTimeout(r, 250));
      launched = appsLaunchedUnder(appHome).filter(({ args }) => args.includes(BUILT_APP_MAIN));
    }
    // An app that dies at startup can still be caught by one poll, so it must be running a poll later.
    await new Promise((r) => setTimeout(r, 250));
    const running = appsLaunchedUnder(appHome).map(({ pid }) => pid);
    runnerWaiting = launched.length > 0 && launched.every(({ pid }) => running.includes(pid)) && runnerExit === undefined;
    for (const { pid } of launched) signal(pid, 'SIGTERM');
    exit = await Promise.race([exited, new Promise<'still running'>((r) => setTimeout(() => r('still running'), 20_000))]);
  } finally {
    for (const { pid } of appsLaunchedUnder(appHome)) signal(pid, 'SIGKILL');
    if (runnerExit === undefined) runner.kill('SIGKILL');
  }

  const launchDir = launched[0]?.launchDir ?? null;
  expect({
    launches: launched.length,
    runnerWaiting,
    launchDirIsRepo: launchDir !== null && existsSync(join(launchDir, '.git')),
    exit,
    printed: output.split('\n').filter((l) => l !== '' && launchDir?.startsWith(`${l}/`)).length,
    output,
  }).toEqual({
    launches: 1,
    runnerWaiting: true,
    launchDirIsRepo: true,
    exit: 0,
    printed: 1,
    output: expect.any(String),
  });
});

test('the app the runner launches is this checkout\'s build, at the bundle the runner reads its revision from', { tag: '@ownapp' }, async () => {
  b = createBenchFixtureBuilder();
  const { dir: folder } = b.makeRepository('bench-e2e-launch');
  const target = benchAppTarget(electronBinary, join(process.cwd(), 'out', 'main'));
  const runDir = temp('bench-e2e-launch-run');
  const launch = { schema_version: BENCH_LAUNCH_SCHEMA, workingFolder: realpathSync(folder), span: { first: 'plan', last: 'plan' }, spanEndFile: join(runDir, 'span-end.json') };
  const home = temp('bench-e2e-launch-home');
  const env = benchLaunchEnv({ ...process.env, APP_SHELL: 'bash', HOME: home, [APP_HOME_DIR_ENV]: home }, launch);

  app = await electron.launch({
    executablePath: target.invocation.execPath,
    args: [...target.invocation.appArgs, `--user-data-dir=${temp('bench-e2e-launch-ud')}`],
    env: Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined)),
  });

  const appPath = await app.evaluate(({ app: a }) => a.getAppPath());
  expect(target.bundle).toEqual({ packaged: false, appPath });
});
