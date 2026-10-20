// #180 — the standalone entry the build emits as `<BENCH_ENTRY>.js`; the `bench` script runs it under
// ELECTRON_RUN_AS_NODE=1.

import { homedir } from 'node:os';
import { benchMain, realBenchDeps } from './benchMain';

const env = { ...process.env, HOME: process.env.HOME || homedir() };
void benchMain(process.argv.slice(2), env, process.cwd(), realBenchDeps(process.execPath, __dirname, env, () => Date.now())).then(({ exitCode, output }) => {
  process.stdout.write(output);
  process.exit(exitCode);
});
