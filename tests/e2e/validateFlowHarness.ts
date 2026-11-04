// Runs `--validate-flow` the way the installed launcher does: the Electron binary in plain-Node mode on the
// checker runtime of a copied, installed build, from a chosen working directory, with an environment the test
// fully specifies. Each test gets its own home, app-state home and Claude config dir, so no run reads the
// operator's real ones, and every process a run starts is gone before the next test.

import { expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { resolveArtifactCheckScript } from '../../src/main/artifactCheck';
import { resolveExampleFlowsDir } from '../../src/main/exampleAssets';

/** The flag as a user types it: the command's contract, not an app constant. */
export const VALIDATE_FLOW_FLAG = '--validate-flow';

const REPO_ROOT = resolve(__dirname, '..', '..');
const requirePackage = createRequire(__filename);

export interface ValidateWorld {
  /** A fresh real-path directory that holds everything below. */
  root: string;
  home: string;
  /** The app-state home A, distinct from `home`. */
  appHome: string;
  /** The Claude config dir; the operator loop tier is `flowLocations.operatorLoops(configDir)`. */
  configDir: string;
  /** A new empty directory under `root`. */
  dir(name: string): string;
}

export interface RunResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export function createValidateWorld(): ValidateWorld {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'validate-flow-')));
  const dir = (name: string): string => {
    const abs = join(root, name);
    mkdirSync(abs, { recursive: true });
    return abs;
  };
  return { root, home: dir('home'), appHome: dir('app-home'), configDir: dir('claude-config'), dir };
}

/** The whole environment a run gets; nothing is inherited from the operator's shell. */
export function runEnv(world: ValidateWorld): Record<string, string> {
  return {
    HOME: world.home,
    APP_HOME_DIR: world.appHome,
    CLAUDE_CONFIG_DIR: world.configDir,
    NODE_PATH: '',
    PATH: '/usr/bin:/bin',
  };
}

/** Copies the built `out/main`, and the third-party packages it leaves external, into an installed-app
 *  directory under `into`. Returns the copied main dir: the checker runtime and the built bundle live there. */
export function installRuntimeCopy(into: string): string {
  const main = join(into, 'installed-app', 'out', 'main');
  cpSync(resolve(REPO_ROOT, 'out', 'main'), main, { recursive: true });
  cpSync(dirname(requirePackage.resolve('js-yaml/package.json')), join(into, 'installed-app', 'node_modules', 'js-yaml'), { recursive: true });
  return main;
}

/** Collects a child's streams and exit, and kills it if the test ends first. */
export class OwnedProcesses {
  private readonly live = new Set<ChildProcess>();

  run(child: ChildProcess): Promise<RunResult> {
    this.live.add(child);
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    return new Promise((done, fail) => {
      child.once('error', (error) => { this.live.delete(child); fail(error); });
      child.once('close', (status, signal) => {
        this.live.delete(child);
        done({ status, signal, stdout, stderr });
      });
    });
  }

  async killAll(): Promise<void> {
    await Promise.all([...this.live].map((child) => new Promise<void>((gone) => {
      child.once('close', () => gone());
      child.kill('SIGKILL');
    })));
  }
}

export interface ValidateRuntime {
  /** The installed copy's main dir, for the bundled flows it ships. */
  runtimeMain(): string;
  world(): ValidateWorld;
  /** Runs the checker runtime with `--validate-flow` then `operands`, each a verbatim argv element. */
  validate(operands: readonly string[], options: { cwd: string }): Promise<RunResult>;
  /** Runs the checker runtime with `args` exactly, for argv the launcher would never produce. */
  runRaw(args: readonly string[], options: { cwd: string }): Promise<RunResult>;
  /** Runs `--validate-flow` then `operands` from `cwd`, which is removed after the run enters it and before the
   *  runtime starts, so the runtime inherits a working directory that no longer exists. */
  validateFromRemovedCwd(operands: readonly string[], options: { cwd: string }): Promise<RunResult>;
  /** Registers work that must finish after each test, before its world is removed. */
  onTeardown(work: () => Promise<void>): void;
}

/** Waits for every piece of work, then reports every failure at once, so one failure never skips another. */
export async function settleAll(work: readonly Promise<unknown>[], what: string): Promise<void> {
  const failed = (await Promise.allSettled(work)).flatMap((r) => (r.status === 'rejected' ? [r.reason] : []));
  if (failed.length > 0) throw new AggregateError(failed, what);
}

/** Call once at the top of a spec: one installed copy per worker, one world per test. */
export function useValidateRuntime(): ValidateRuntime {
  let installRoot: string | undefined;
  let main: string | undefined;
  let current: ValidateWorld | undefined;
  const owned = new OwnedProcesses();
  const teardowns: (() => Promise<void>)[] = [];

  test.beforeAll(() => {
    installRoot = realpathSync(mkdtempSync(join(tmpdir(), 'validate-flow-install-')));
    main = installRuntimeCopy(installRoot);
  });
  test.afterAll(() => {
    if (installRoot !== undefined) rmSync(installRoot, { recursive: true, force: true });
  });
  test.beforeEach(() => { current = createValidateWorld(); });
  test.afterEach(async () => {
    try {
      await settleAll([owned.killAll(), ...teardowns.map((work) => work())], 'teardown before removing the world failed');
    } finally {
      if (current !== undefined) rmSync(current.root, { recursive: true, force: true });
      current = undefined;
    }
  });

  const runtimeMain = (): string => {
    if (main === undefined) throw new Error('useValidateRuntime(): the runtime is read before its suite installed it');
    return main;
  };
  const world = (): ValidateWorld => {
    if (current === undefined) throw new Error('useValidateRuntime(): the world is read outside a test');
    return current;
  };
  const runRaw = (args: readonly string[], { cwd }: { cwd: string }): Promise<RunResult> =>
    owned.run(spawn(requirePackage('electron') as string, [resolveArtifactCheckScript(runtimeMain()), ...args], {
      cwd,
      env: { ...runEnv(world()), ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
  const validateFromRemovedCwd = (operands: readonly string[], { cwd }: { cwd: string }): Promise<RunResult> =>
    owned.run(spawn('/bin/sh', ['-c', 'cd "$1" && rmdir "$1" && shift && exec "$@"', 'sh', cwd,
      requirePackage('electron') as string, resolveArtifactCheckScript(runtimeMain()), VALIDATE_FLOW_FLAG, ...operands], {
      cwd: world().root,
      env: { ...runEnv(world()), ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
  return {
    runtimeMain,
    world,
    runRaw,
    validateFromRemovedCwd,
    onTeardown: (work) => { teardowns.push(work); },
    validate: (operands, options) => runRaw([VALIDATE_FLOW_FLAG, ...operands], options),
  };
}

/** Every flow folder the built bundle under `runtimeMain` ships, then every `example/flows/<id>/` of this source
 *  tree, enumerated so a new bundled flow is covered without a test change. */
export function bundledFlowFolders(runtimeMain: string): string[] {
  const entries = (flowsDir: string): string[] => {
    const dirs = readdirSync(flowsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(flowsDir, e.name)).sort();
    if (dirs.length === 0) throw new Error(`bundledFlowFolders(): no flow folder under ${flowsDir}`);
    return dirs;
  };
  return [
    ...entries(resolveExampleFlowsDir({ packaged: false, appPath: runtimeMain })),
    ...entries(resolveExampleFlowsDir({ packaged: false, appPath: REPO_ROOT })),
  ];
}

const ONE_LINE = /^[^\r\n]+\n?$/;

/** What a run printed and returned, for a failure diff. */
export function runText(result: RunResult): string {
  return `exit ${String(result.status)}${result.signal === null ? '' : ` (${result.signal})`}; stdout: ${JSON.stringify(result.stdout)}; stderr: ${JSON.stringify(result.stderr)}`;
}

/** A pass, reduced to the CLI contract's facts for one `toEqual(PASSED)` in the spec, so the failure is reported
 *  at the spec's own line, as an assertion, and its diff names every fact that is wrong. `output` is the whole run,
 *  for the diff only: every expectation accepts any text there. */
export function passOutcome(result: RunResult): { status: number | null; oneLine: boolean; okLine: boolean; output: string } {
  const oneLine = ONE_LINE.test(result.stdout);
  return { status: result.status, oneLine, okLine: oneLine && result.stdout.startsWith('OK: '), output: runText(result) };
}

export const PASSED = { status: 0, oneLine: true, okLine: true, output: expect.any(String) };

/** A problem, reduced to the CLI contract's facts: the exit status, whether standard output is exactly one line,
 *  whether it starts with one of `paths` then ": ", and the problem text after that prefix (the whole output when
 *  no prefix matched). */
export function problemOutcome(
  result: RunResult,
  paths: string | readonly string[],
): { status: number | null; oneLine: boolean; prefixed: boolean; problem: string; output: string } {
  const line = result.stdout.replace(/\n$/, '');
  const prefix = [paths].flat().map((p) => `${p}: `).find((p) => line.startsWith(p));
  return {
    status: result.status,
    oneLine: ONE_LINE.test(result.stdout),
    prefixed: prefix !== undefined,
    problem: prefix === undefined ? line : line.slice(prefix.length),
    output: runText(result),
  };
}

/** The expected `problemOutcome`: exit 1, one prefixed line, and a problem text that `problem` matches. */
export function problemLine(problem: unknown = expect.any(String)): { status: 1; oneLine: true; prefixed: true; problem: unknown; output: unknown } {
  return { status: 1, oneLine: true, prefixed: true, problem, output: expect.any(String) };
}

/** A usage error, reduced to the CLI contract's facts. */
export function usageOutcome(result: RunResult): { status: number | null; stdout: string; stderrWritten: boolean; output: string } {
  return { status: result.status, stdout: result.stdout, stderrWritten: result.stderr.trim() !== '', output: runText(result) };
}

export const USAGE = { status: 2, stdout: '', stderrWritten: true, output: expect.any(String) };

/** The two absolute spellings a refusal of folder `operand` may print: resolved lexically against `cwd`, or
 *  with its parent's links resolved and its own name kept. */
export function folderPrefixes(cwd: string, operand: string): string[] {
  const lexical = resolve(cwd, operand);
  try {
    return [...new Set([lexical, join(realpathSync(dirname(lexical)), basename(lexical))])];
  } catch {
    return [lexical];
  }
}

/** The errno code and its description (`ENOENT: no such file or directory`) of the error `provoke` throws,
 *  without the system-call name or path, for an oracle the test provokes itself. */
export function errnoDescription(provoke: () => unknown): string {
  try {
    provoke();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return message.split(', ')[0];
  }
  throw new Error('errnoDescription(): the call did not fail');
}
