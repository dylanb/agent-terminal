// Runs the checker runtime the way the installed launcher does: the Electron binary in plain-Node mode on the
// runtime of a copied, installed build, from a chosen working directory, with an environment the test fully
// specifies. Each test gets its own home, app-state home and Claude config dir, so no run reads the operator's
// real ones, and every process a run starts is gone before the next test.

import { test, type TestInfo } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { resolveArtifactCheckScript } from '../../src/main/artifactCheck';
import type { RunResult } from '../helpers/validateOutcome';

export const REPO_ROOT = resolve(__dirname, '..', '..');
const requirePackage = createRequire(__filename);

export interface RuntimeWorld {
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

export function createRuntimeWorld(): RuntimeWorld {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'installed-runtime-')));
  const dir = (name: string): string => {
    const abs = join(root, name);
    mkdirSync(abs, { recursive: true });
    return abs;
  };
  return { root, home: dir('home'), appHome: dir('app-home'), configDir: dir('claude-config'), dir };
}

/** The whole environment a run gets; nothing is inherited from the operator's shell. */
export function runEnv(world: RuntimeWorld): Record<string, string> {
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

/** Waits for every piece of work, then reports every failure at once, so one failure never skips another. */
export async function settleAll(work: readonly Promise<unknown>[], what: string): Promise<void> {
  const failed = (await Promise.allSettled(work)).flatMap((r) => (r.status === 'rejected' ? [r.reason] : []));
  if (failed.length > 0) throw new AggregateError(failed, what);
}

export interface RunOptions {
  cwd: string;
  /** Laid over `runEnv`; a key set to `undefined` is left out of the run's environment. */
  env?: Readonly<Record<string, string | undefined>>;
}

function overlaid(base: Record<string, string>, overlay: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const merged: Record<string, string | undefined> = { ...base, ...overlay };
  return Object.fromEntries(Object.entries(merged).flatMap(([k, v]) => (v === undefined ? [] : [[k, v]])));
}

export interface InstalledRuntime {
  /** The installed copy's main dir, for the bundled flows it ships. */
  runtimeMain(): string;
  world(): RuntimeWorld;
  /** The command that starts the checker runtime: the Electron binary, then the runtime script. */
  runtimeCommand(): readonly [string, string];
  runRaw(args: readonly string[], options: RunOptions): Promise<RunResult>;
  /** Runs `command` with `args` in the run environment, owned like any run, for a wrapper that starts the
   *  runtime itself. */
  runOwned(command: string, args: readonly string[], options: RunOptions): Promise<RunResult>;
  /** Registers work that must finish after each test, before its world is removed. */
  onTeardown(work: (testInfo: TestInfo) => Promise<void>): void;
}

/** Call once at the top of a spec: one installed copy per worker, one world per test. */
export function useInstalledRuntime(): InstalledRuntime {
  let installRoot: string | undefined;
  let main: string | undefined;
  let current: RuntimeWorld | undefined;
  const owned = new OwnedProcesses();
  const teardowns: ((testInfo: TestInfo) => Promise<void>)[] = [];

  test.beforeAll(() => {
    installRoot = realpathSync(mkdtempSync(join(tmpdir(), 'installed-runtime-install-')));
    main = installRuntimeCopy(installRoot);
  });
  test.afterAll(() => {
    if (installRoot !== undefined) rmSync(installRoot, { recursive: true, force: true });
  });
  test.beforeEach(() => { current = createRuntimeWorld(); });
  test.afterEach(async ({}, testInfo) => {
    try {
      await settleAll([owned.killAll(), ...teardowns.map((work) => work(testInfo))], 'teardown before removing the world failed');
    } finally {
      if (current !== undefined) rmSync(current.root, { recursive: true, force: true });
      current = undefined;
    }
  });

  const runtimeMain = (): string => {
    if (main === undefined) throw new Error('useInstalledRuntime(): the runtime is read before its suite installed it');
    return main;
  };
  const world = (): RuntimeWorld => {
    if (current === undefined) throw new Error('useInstalledRuntime(): the world is read outside a test');
    return current;
  };
  const runtimeCommand = (): readonly [string, string] => [requirePackage('electron') as string, resolveArtifactCheckScript(runtimeMain())];
  const runOwned = (command: string, args: readonly string[], { cwd, env = {} }: RunOptions): Promise<RunResult> =>
    owned.run(spawn(command, args, {
      cwd,
      env: overlaid({ ...runEnv(world()), ELECTRON_RUN_AS_NODE: '1' }, env),
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
  return {
    runtimeMain,
    world,
    runtimeCommand,
    runOwned,
    runRaw: (args, options) => {
      const [electron, script] = runtimeCommand();
      return runOwned(electron, [script, ...args], options);
    },
    onTeardown: (work) => { teardowns.push(work); },
  };
}
