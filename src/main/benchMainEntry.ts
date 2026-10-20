// #180 — the standalone entry the build emits as `<BENCH_ENTRY>.js`; the `bench` script runs it under
// ELECTRON_RUN_AS_NODE=1.

import { benchMain } from './benchMain';
import { createBenchGithub } from './benchGithub';

void benchMain(process.argv.slice(2), process.env, process.cwd(), { github: createBenchGithub() }).then(({ exitCode, output }) => {
  process.stdout.write(output);
  process.exit(exitCode);
});
