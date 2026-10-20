// #180 — the bench runner's pure entry: argv, env and the invoking directory in, an exit code and the printed
// output out.

import type { BenchGithub } from './benchGithub';

/** The rollup entry name the build emits the runner under (`out/main/<BENCH_ENTRY>.js`). */
export const BENCH_ENTRY = 'bench';

export interface BenchDeps {
  github: BenchGithub;
}

export interface BenchOutcome {
  exitCode: number;
  output: string;
}

export async function benchMain(_argv: string[], _env: NodeJS.ProcessEnv, _cwd: string, _deps: BenchDeps): Promise<BenchOutcome> {
  return { exitCode: 1, output: '' };
}
