import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { benchLaunchEnv, createBenchLauncher } from '../../src/main/benchLauncher';
import { APP_LAUNCH_DIR_ENV } from '../../src/main/launchRoot';
import { BENCH_LAUNCH_ENV, BENCH_LAUNCH_SCHEMA, decodeBenchLaunch, type BenchLaunch } from '../../src/shared/benchLaunch';

// #180 — the real launcher, over a stand-in app: a node script that writes the env it received and a `started`
// marker, then stays open until the test writes a release file.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const STAND_IN = `
const fs = require('node:fs');
const path = require('node:path');
const dir = process.argv[2];
fs.writeFileSync(path.join(dir, 'env.json'), JSON.stringify(process.env));
fs.writeFileSync(path.join(dir, 'started'), '');
const release = path.join(dir, 'release');
const wait = () => (fs.existsSync(release) ? process.exit(Number(fs.readFileSync(release, 'utf8') || '0')) : setTimeout(wait, 10));
wait();
`;

const WAIT_MS = 10_000;

const RUNNER_ENV: NodeJS.ProcessEnv = { PATH: process.env.PATH, ELECTRON_RUN_AS_NODE: '1', BENCH_RUNNER_MARK: 'kept' };

function standIn(): { dir: string; launch: BenchLaunch; open: () => Promise<void> } {
  const dir = mkdtempSync(join(tmpdir(), 'bench-launcher-'));
  dirs.push(dir);
  const script = join(dir, 'app.cjs');
  writeFileSync(script, STAND_IN);
  const launch: BenchLaunch = { schema_version: BENCH_LAUNCH_SCHEMA, workingFolder: dir, span: { first: 'plan', last: 'plan' }, spanEndFile: join(dir, 'span-end.json') };
  const launcher = createBenchLauncher({ execPath: process.execPath, appArgs: [script, dir] }, RUNNER_ENV);
  return { dir, launch, open: () => launcher.open(launch) };
}

/** Polls until `done()` holds or the wait runs out; the caller asserts on what it then observes. */
async function until(done: () => boolean): Promise<void> {
  const end = Date.now() + WAIT_MS;
  while (!done() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
}

describe('the real launcher', () => {
  it('resolves open() only after the launched app exits', async () => {
    const { dir, open } = standIn();
    let resolved = false;
    let rejected = false;
    const opened = open().then(
      () => (resolved = true),
      () => (rejected = true),
    );

    await until(() => resolved || rejected || existsSync(join(dir, 'started')));
    const atStart = { started: existsSync(join(dir, 'started')), settled: resolved || rejected };
    writeFileSync(join(dir, 'release'), '');
    await Promise.race([opened, until(() => false)]);

    expect({ atStart, afterExit: resolved }).toEqual({ atStart: { started: true, settled: false }, afterExit: true });
  }, 2 * WAIT_MS + 5_000);

  it('resolves open(), never rejects, when the launched app exits with a failure code', async () => {
    const { dir, open } = standIn();
    let settled: 'resolved' | 'rejected' | null = null;
    const opened = open().then(
      () => (settled = 'resolved'),
      () => (settled = 'rejected'),
    );

    await until(() => settled !== null || existsSync(join(dir, 'started')));
    const atStart = { started: existsSync(join(dir, 'started')), settled };
    writeFileSync(join(dir, 'release'), '3');
    await Promise.race([opened, until(() => false)]);

    expect({ atStart, afterExit: settled }).toEqual({ atStart: { started: true, settled: null }, afterExit: 'resolved' });
  }, 2 * WAIT_MS + 5_000);

  it('resolves open(), never rejects, when the app cannot be started at all', async () => {
    const { dir, launch } = standIn();
    const launcher = createBenchLauncher({ execPath: join(dir, 'no-such-electron'), appArgs: [] }, RUNNER_ENV);

    await expect(Promise.race([launcher.open(launch).then(() => 'resolved'), until(() => false).then(() => 'pending')])).resolves.toBe('resolved');
  }, WAIT_MS + 5_000);

  it("launches the app with the runner's env, the launch value and its working folder, not in plain-Node mode, and exactly as benchLaunchEnv composes it", async () => {
    const { dir, launch, open } = standIn();
    let settled = false;
    const opened = open().then(
      () => (settled = true),
      () => (settled = true),
    );
    await until(() => settled || existsSync(join(dir, 'started')));
    writeFileSync(join(dir, 'release'), '');
    await opened;

    const envFile = join(dir, 'env.json');
    const env = existsSync(envFile) ? (JSON.parse(readFileSync(envFile, 'utf8')) as Record<string, string>) : null;
    const composed = benchLaunchEnv(RUNNER_ENV, launch);
    expect({
      plainNode: env === null ? null : 'ELECTRON_RUN_AS_NODE' in env,
      carried: env?.BENCH_RUNNER_MARK,
      launchDir: env?.[APP_LAUNCH_DIR_ENV],
      launch: env?.[BENCH_LAUNCH_ENV] === undefined ? null : decodeBenchLaunch(env[BENCH_LAUNCH_ENV]),
      composedMissing: env === null ? null : Object.entries(composed).filter(([k, v]) => env[k] !== v).map(([k]) => k),
      composedPlainNode: 'ELECTRON_RUN_AS_NODE' in composed,
    }).toEqual({ plainNode: false, carried: 'kept', launchDir: launch.workingFolder, launch: { ok: true, launch }, composedMissing: [], composedPlainNode: false });
  }, 2 * WAIT_MS + 5_000);
});

