import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realBenchDeps } from '../../src/main/benchMain';
import { benchAppTarget } from '../../src/main/benchLauncher';
import { BENCH_LAUNCH_ENV, BENCH_LAUNCH_SCHEMA, decodeBenchLaunch, type BenchLaunch } from '../../src/shared/benchLaunch';

// #180 — the production deps the entry builds: the launcher opens the app the runner's own target names with
// the runner's env, the bundle is that same target's, and the clock reads the time source it was given. The
// "app" is a stand-in `index.js` in the main dir, which writes the env it received and waits for a release file.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const POLL_MS = 10;

const STAND_IN = `
const fs = require('node:fs');
const path = require('node:path');
fs.writeFileSync(path.join(__dirname, 'env.json'), JSON.stringify(process.env));
const wait = () => (fs.existsSync(path.join(__dirname, 'release')) ? process.exit(0) : setTimeout(wait, ${POLL_MS}));
wait();
`;

const WAIT_MS = 10_000;

async function until(done: () => boolean): Promise<void> {
  const end = Date.now() + WAIT_MS;
  while (!done() && Date.now() < end) await new Promise((r) => setTimeout(r, POLL_MS));
}

describe('realBenchDeps', () => {
  it("wires the launcher to its own target and the runner's env, the bundle to that target, and the clock to the time source", async () => {
    const mainDir = mkdtempSync(join(tmpdir(), 'bench-main-dir-'));
    dirs.push(mainDir);
    writeFileSync(join(mainDir, 'index.js'), STAND_IN);
    const launch: BenchLaunch = { schema_version: BENCH_LAUNCH_SCHEMA, workingFolder: mainDir, span: { first: 'plan', last: 'plan' }, spanEndFile: join(mainDir, 'span-end.json') };
    const deps = realBenchDeps(process.execPath, mainDir, { PATH: process.env.PATH, BENCH_RUNNER_MARK: 'kept' }, () => 1_792_497_052_251);

    let settled = false;
    const opened = deps.launcher.open(launch).then(
      () => (settled = true),
      () => (settled = true),
    );
    const envFile = join(mainDir, 'env.json');
    await until(() => settled || existsSync(envFile));
    const openWhileRunning = !settled;
    writeFileSync(join(mainDir, 'release'), '');
    await opened;

    const env = existsSync(envFile) ? (JSON.parse(readFileSync(envFile, 'utf8')) as Record<string, string>) : null;
    expect({
      openWhileRunning,
      carried: env?.BENCH_RUNNER_MARK,
      launch: env?.[BENCH_LAUNCH_ENV] === undefined ? null : decodeBenchLaunch(env[BENCH_LAUNCH_ENV]),
      bundle: deps.appBundle,
      now: deps.clock.now(),
    }).toEqual({
      openWhileRunning: true,
      carried: 'kept',
      launch: { ok: true, launch },
      bundle: benchAppTarget(process.execPath, mainDir).bundle,
      now: 1_792_497_052_251,
    });
  }, WAIT_MS + 5_000);
});
