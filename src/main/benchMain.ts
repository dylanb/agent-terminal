import { realpathSync } from 'node:fs';
import path from 'node:path';
import { runAppCommand } from './appCommand';
import { createBenchGithub } from './benchGithub';
import { captureFixture, type BenchCaptureRefusal } from './benchCapture';
import { benchAppTarget, createBenchLauncher } from './benchLauncher';
import { createBenchClock, runBench, type BenchFlowRef, type BenchRunDeps, type BenchRunRefusal } from './benchRun';
import { errMsg } from './errno';
import { resolveAppHome } from './launchRoot';
import { userConfigRootFrom } from './userConfig';
import type { BenchSpan } from '../shared/benchLaunch';

/** The rollup entry name the build emits the runner under (`out/main/<BENCH_ENTRY>.js`). */
export const BENCH_ENTRY = 'bench';

export type BenchDeps = BenchRunDeps;

export interface BenchOutcome {
  exitCode: number;
  output: string;
}

/** `execPath` and `mainDir` are the runner's own Electron binary and built main directory; `now` is epoch ms. */
export function realBenchDeps(execPath: string, mainDir: string, env: NodeJS.ProcessEnv, now: () => number): BenchDeps {
  const target = benchAppTarget(execPath, mainDir);
  return {
    github: createBenchGithub(),
    launcher: createBenchLauncher(target.invocation, env),
    appBundle: target.bundle,
    clock: createBenchClock(now),
  };
}

const USAGE =
  'usage: bench capture <working-folder> <fixture-dir>\n' +
  '       bench run --flow <catalog-id|path to flow.yaml> --span <first>[..<last>] --fixture <fixture-dir> --runs <n>\n';

const CAPTURE_REFUSALS: Record<BenchCaptureRefusal, string> = {
  'uncommitted-changes': 'the working folder has changes outside .agent-terminal/ that are not committed',
  'fixture-exists': 'the fixture folder already exists',
  'ticket-unresolved': "the folder's flow does not load, declares no ticket input, or its ticket input does not name an issue number",
  'artifact-escapes': 'a loop artifact resolves outside the working folder or cannot be resolved (a dangling or unreadable link)',
};

const RUN_REFUSALS: Record<BenchRunRefusal, string> = {
  'flow-unloadable': 'the flow, or one of its loop definitions, does not load',
  'span-unknown-step': 'a span step is not a step of the flow',
  'span-out-of-order': "the span's last step comes before its first in the flow",
  'runs-invalid': 'the run count is not a whole number of at least 1',
  'fixture-unparsable': "the fixture's fixture.json is not a fixture, or its inputs hold the flow's ticket input",
  'commit-absent': "the fixture's commit is not in the invoking repository",
  'issue-other-repository': "the fixture's issue is not in the invoking repository's GitHub repository",
  'pr-acting-gate': "the span starts after the flow's pickup step and holds a gate that acts on the pickup pull request",
  'label-failed': 'the bench-run label could not be looked up, or is missing and could not be created',
  'stamp-exists': "this command's run folder already exists",
  'restore-escapes': 'a fixture artifact, a flow-home file or a restore destination resolves outside its folder or cannot be resolved',
  'issue-copy-failed': "the fixture's issue could not be copied",
  'prepare-failed': "a run's working folder could not be prepared",
  'output-failed': "a run's record or audit log could not be written to its run folder",
};

const RUN_FLAGS = ['--flow', '--span', '--fixture', '--runs'] as const;
type RunFlag = (typeof RUN_FLAGS)[number];

function parseRunFlags(args: string[]): Record<RunFlag, string> | null {
  const values: Partial<Record<RunFlag, string>> = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = RUN_FLAGS.find((f) => f === args[i]);
    const value = args[i + 1];
    if (flag === undefined || value === undefined || values[flag] !== undefined) return null;
    values[flag] = value;
  }
  return RUN_FLAGS.every((f) => values[f] !== undefined) ? (values as Record<RunFlag, string>) : null;
}

const isFlowPath = (value: string): boolean => value.includes('/') || value.endsWith('.yaml') || value.endsWith('.yml');

function parseSpan(value: string): BenchSpan {
  const at = value.indexOf('..');
  return at < 0 ? { first: value, last: value } : { first: value.slice(0, at), last: value.slice(at + 2) };
}

/** The top level of the repository `dir` is in, as a real path: the folder the app keys a repository on. */
async function repositoryRoot(dir: string): Promise<string> {
  return realpathSync(await runAppCommand('git', ['rev-parse', '--show-toplevel'], dir).then((out) => out.trim()));
}

/** Writes `text` where the operator reads it, as soon as it is known. */
export type BenchPrint = (text: string) => void;

async function benchRunCommand(args: string[], env: NodeJS.ProcessEnv, invoking: string, deps: BenchDeps, print: BenchPrint): Promise<BenchOutcome> {
  const flags = parseRunFlags(args);
  if (flags === null) return { exitCode: 1, output: USAGE };
  const flow: BenchFlowRef = isFlowPath(flags['--flow']) ? { kind: 'path', file: path.resolve(invoking, flags['--flow']) } : { kind: 'id', id: flags['--flow'] };
  const home = env.HOME ?? '';
  const result = await runBench({
    flow,
    span: parseSpan(flags['--span']),
    fixtureDir: path.resolve(invoking, flags['--fixture']),
    runs: flags['--runs'],
    invokingRepo: await repositoryRoot(invoking),
    appHome: resolveAppHome(env, home),
    userConfigRoot: userConfigRootFrom(env, home),
    reportRunFolder: (folder) => print(`${folder}\n`),
    deps,
  });
  if (result.ok) return { exitCode: 0, output: '' };
  return { exitCode: 1, output: `bench run refused (${result.code}): ${RUN_REFUSALS[result.code]}${result.reason === undefined ? '' : ` — ${result.reason}`}\n` };
}

async function benchCaptureCommand(args: string[], env: NodeJS.ProcessEnv, invoking: string, deps: BenchDeps, _print: BenchPrint): Promise<BenchOutcome> {
  const [workingFolder, fixtureDir, ...rest] = args;
  if (workingFolder === undefined || fixtureDir === undefined || rest.length > 0) return { exitCode: 1, output: USAGE };
  const fixture = path.resolve(invoking, fixtureDir);
  const result = await captureFixture({
    workingFolder: path.resolve(invoking, workingFolder),
    fixtureDir: fixture,
    appHome: resolveAppHome(env, env.HOME ?? ''),
    github: deps.github,
  });
  if (!result.ok) return { exitCode: 1, output: `bench capture refused (${result.code}): ${CAPTURE_REFUSALS[result.code]}\n` };
  return { exitCode: 0, output: `${fixture}\n` };
}

const COMMANDS = { capture: benchCaptureCommand, run: benchRunCommand } as const;

/** `output` is what is left to print once the command ends; run folders go to `print` as they are made. */
export async function benchMain(argv: string[], env: NodeJS.ProcessEnv, cwd: string, deps: BenchDeps, print: BenchPrint): Promise<BenchOutcome> {
  // `pnpm run` moves the working directory to the package root and names the invoking one in INIT_CWD.
  const invoking = env.INIT_CWD || cwd;
  const [command, ...args] = argv;
  if (command !== 'capture' && command !== 'run') return { exitCode: 1, output: USAGE };
  try {
    return await COMMANDS[command](args, env, invoking, deps, print);
  } catch (e) {
    return { exitCode: 1, output: `bench ${command} failed: ${errMsg(e)}\n` };
  }
}
