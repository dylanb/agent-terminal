// #180 — the bench runner's pure entry: argv, env and the invoking directory in, an exit code and the printed
// output out.

import path from 'node:path';
import { createBenchGithub, type BenchGithub } from './benchGithub';
import { captureFixture, type BenchCaptureRefusal } from './benchCapture';
import { errMsg } from './errno';
import { resolveAppHome } from './launchRoot';

/** The rollup entry name the build emits the runner under (`out/main/<BENCH_ENTRY>.js`). */
export const BENCH_ENTRY = 'bench';

export interface BenchDeps {
  github: BenchGithub;
}

export interface BenchOutcome {
  exitCode: number;
  output: string;
}

export function realBenchDeps(): BenchDeps {
  return { github: createBenchGithub() };
}

const USAGE = 'usage: bench capture <working-folder> <fixture-dir>\n';

const CAPTURE_REFUSALS: Record<BenchCaptureRefusal, string> = {
  'uncommitted-changes': 'the working folder has changes outside .agent-terminal/ that are not committed',
  'fixture-exists': 'the fixture folder already exists',
  'ticket-unresolved': "the folder's flow does not load, declares no ticket input, or its ticket input does not name an issue number",
  'artifact-escapes': 'a loop artifact resolves outside the working folder or cannot be resolved (a dangling or unreadable link)',
};

export async function benchMain(argv: string[], env: NodeJS.ProcessEnv, cwd: string, deps: BenchDeps): Promise<BenchOutcome> {
  const [command, workingFolder, fixtureDir, ...rest] = argv;
  if (command !== 'capture' || workingFolder === undefined || fixtureDir === undefined || rest.length > 0) return { exitCode: 1, output: USAGE };
  // `pnpm run` moves the working directory to the package root and names the invoking one in INIT_CWD.
  const invoking = env.INIT_CWD || cwd;
  const fixture = path.resolve(invoking, fixtureDir);
  try {
    const result = await captureFixture({
      workingFolder: path.resolve(invoking, workingFolder),
      fixtureDir: fixture,
      appHome: resolveAppHome(env, env.HOME ?? ''),
      github: deps.github,
    });
    if (!result.ok) return { exitCode: 1, output: `bench capture refused (${result.code}): ${CAPTURE_REFUSALS[result.code]}\n` };
    return { exitCode: 0, output: `${fixture}\n` };
  } catch (e) {
    return { exitCode: 1, output: `bench capture failed: ${errMsg(e)}\n` };
  }
}
