// Installs the `agent-terminal` launcher from the Settings UI of an app the test owns, and runs the installed
// command from a shell the way an operator would. Each installed run starts in its own process group and carries
// a marker in its environment, so the test can confirm nothing it started survives — including the detached app
// launch an installed launcher without a `--validate-flow` branch falls through to — and can kill whatever does.

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isErrno } from '../../src/main/errno';
import { WINDOW_TIMEOUT_MS } from '../helpers/e2eBudget';
import { electron } from './registeredElectron';
import { OwnedProcesses, runEnv, settleAll, type RunResult, type ValidateRuntime, type ValidateWorld } from './validateFlowHarness';

const RUN_MARKER_ENV = 'AGENT_TERMINAL_TEST_RUN';
const INSTALL_BUTTON = 'Install the agent-terminal command-line launcher';
const DISPLAY_ENV = ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY'] as const;

/** The host's display, so an app an installed run wrongly launches stays up until the survivor check sees it
 *  instead of dying for want of a display. */
function displayEnv(): Record<string, string> {
  return Object.fromEntries(DISPLAY_ENV.flatMap((key) => {
    const value = process.env[key];
    return value === undefined ? [] : [[key, value]];
  }));
}

export interface OwnApp {
  app: ElectronApplication;
  page: Page;
}

/** Launches this build with the world's homes and config dir, `bash` as its shell and the run PATH, so neither
 *  the host's shell nor its PATH can change where the install lands. */
async function launchOwnApp(world: ValidateWorld, own: (app: ElectronApplication) => void): Promise<OwnApp> {
  const app = await electron.launch({
    args: ['out/main/index.js'],
    env: {
      ...(process.env as Record<string, string>),
      ...runEnv(world),
      CODEX_HOME: join(world.home, '.codex'),
      APP_SHELL: 'bash',
      APP_SUBMIT_DELAY_MS: '100',
    },
  });
  own(app);
  const page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  return { app, page };
}

/** Presses the Settings install control and returns the absolute path of the command it reports installing. */
async function installLauncher(page: Page, world: ValidateWorld): Promise<string> {
  await page.locator('[data-viewbtn="4"]').click();
  const view = page.locator('#cli-install-view');
  await view.getByRole('button', { name: INSTALL_BUTTON }).click();
  const status = view.getByRole('status');
  const alert = view.getByRole('alert');
  await expect(status.filter({ hasText: world.home }).or(alert.filter({ hasText: /\S/ }))).toBeVisible({ timeout: 0 });
  expect(await alert.textContent(), 'the install reported no failure').toBe('');
  const text = (await status.textContent()) ?? '';
  const installed = text.slice(text.indexOf(world.home)).split(/\s/)[0].replace(/\.$/, '');
  expect(existsSync(installed), `the install reported ${installed}, which exists`).toBe(true);
  return installed;
}

export interface InstalledRun extends RunResult {
  pgid: number;
  marker: string;
}

type Platform = NodeJS.Platform;

function psRows(args: string[]): string[] {
  return execFileSync('ps', args, { encoding: 'utf8' }).split('\n').map((l) => l.trim()).filter(Boolean);
}

function groupMembers(pgid: number): number[] {
  return psRows(['-A', '-o', 'pid=,pgid=,stat=']).flatMap((row) => {
    const [pid, group, stat] = row.split(/\s+/);
    return Number(group) === pgid && !stat.startsWith('Z') ? [Number(pid)] : [];
  });
}

function markerCarriers(entry: string, platform: Platform): number[] {
  if (platform === 'linux') {
    return readdirSync('/proc').filter((name) => /^\d+$/.test(name)).flatMap((pid) => {
      try {
        return readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(entry) ? [Number(pid)] : [];
      } catch {
        return [];
      }
    });
  }
  return psRows(['-E', '-ww', '-A', '-o', 'pid=,stat=,command=']).flatMap((row) => {
    const [pid, stat] = row.split(/\s+/);
    return !stat.startsWith('Z') && ` ${row} `.includes(` ${entry} `) ? [Number(pid)] : [];
  });
}

function killQuietly(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch (e) {
    if (!isErrno(e, 'ESRCH')) throw e;
  }
}

/** Runs installed commands and owns every process they start. */
class InstalledRuns {
  private readonly owned = new OwnedProcesses();
  private readonly started: Pick<InstalledRun, 'pgid' | 'marker'>[] = [];
  /** Marker entries handed out for commands the test starts some other way, such as typed into the app's own
   *  terminal. */
  private readonly marked: string[] = [];
  /** A group seen empty is never consulted again: its id may since belong to an unrelated process. */
  private readonly emptied = new Set<number>();

  constructor(private readonly world: ValidateWorld, private readonly platform: Platform) {}

  /** Runs `command` with `args` from `cwd`, in a new process group, with the world's run environment. */
  async run(command: string, args: readonly string[], cwd: string): Promise<InstalledRun> {
    const marker = `${this.world.root}#${this.started.length + 1}`;
    const child = spawn(command, args, {
      cwd,
      env: { ...runEnv(this.world), ...displayEnv(), [RUN_MARKER_ENV]: marker },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const pending = this.owned.run(child);
    if (child.pid === undefined) {
      await pending;
      throw new Error(`InstalledRuns.run(): ${command} did not start`);
    }
    const group = { pgid: child.pid, marker };
    this.started.push(group);
    return { ...(await pending), ...group };
  }

  mark(): string {
    const entry = `${RUN_MARKER_ENV}=${this.world.root}#marked-${this.marked.length + 1}`;
    this.marked.push(entry);
    return entry;
  }

  carriers(entry: string): number[] {
    return markerCarriers(entry, this.platform).sort((a, b) => a - b);
  }

  /** Every live process in `run`'s group or carrying its marker, ascending. */
  survivors(run: Pick<InstalledRun, 'pgid' | 'marker'>): number[] {
    const members = this.emptied.has(run.pgid) ? [] : groupMembers(run.pgid);
    if (members.length === 0) this.emptied.add(run.pgid);
    const pids = new Set([...members, ...markerCarriers(`${RUN_MARKER_ENV}=${run.marker}`, this.platform)]);
    return [...pids].sort((a, b) => a - b);
  }

  /** Kills everything every run left, then waits until none of it is alive; one run's failure never stops
   *  another's cleanup. */
  async cleanup(): Promise<void> {
    const reap = async (run: Pick<InstalledRun, 'pgid' | 'marker'>): Promise<void> => {
      await expect.poll(() => {
        const alive = this.survivors(run);
        for (const pid of alive) killQuietly(pid);
        return alive;
      }, { timeout: 0 }).toEqual([]);
    };
    const reapMarked = async (entry: string): Promise<void> => {
      await expect.poll(() => {
        const alive = this.carriers(entry);
        for (const pid of alive) killQuietly(pid);
        return alive;
      }, { timeout: 0 }).toEqual([]);
    };
    await settleAll([this.owned.killAll(), ...this.started.splice(0).map(reap), ...this.marked.splice(0).map(reapMarked)], 'installed runs left processes behind');
  }
}

export interface InstalledLauncher {
  /** Launches the test's own app; it is closed after the test. */
  launch(): Promise<OwnApp>;
  /** Presses the Settings install control and returns the absolute path of the command it reports installing. */
  install(page: Page): Promise<string>;
  /** Runs `command` with `args` from `cwd`, in a new process group, with the world's run environment. */
  run(command: string, args: readonly string[], cwd: string): Promise<InstalledRun>;
  /** Every live process in `run`'s group or carrying its marker, ascending. */
  survivors(run: Pick<InstalledRun, 'pgid' | 'marker'>): number[];
  /** A marker environment entry, `NAME=value`, for a command the test starts itself; teardown kills and confirms
   *  gone every process that carries it. */
  mark(): string;
  /** Every live process carrying the marker entry `entry`, ascending. */
  carriers(entry: string): number[];
}

/** Call once at the top of a spec, after `useValidateRuntime()`. After each test, before the world is removed, it
 *  kills and confirms gone everything an installed run started, and closes every app `launch()` started. */
export function useInstalledLauncher(runtime: ValidateRuntime, platform: NodeJS.Platform): InstalledLauncher {
  let runs: InstalledRuns | undefined;
  const apps: ElectronApplication[] = [];
  test.beforeEach(() => { runs = new InstalledRuns(runtime.world(), platform); });
  runtime.onTeardown(async () => {
    const finished = runs;
    runs = undefined;
    await settleAll([...(finished ? [finished.cleanup()] : []), ...apps.splice(0).map((app) => app.close())], 'teardown of the installed launcher failed');
  });
  const current = (): InstalledRuns => {
    if (runs === undefined) throw new Error('useInstalledLauncher(): used outside a test');
    return runs;
  };
  return {
    launch: () => launchOwnApp(runtime.world(), (app) => apps.push(app)),
    install: (page) => installLauncher(page, runtime.world()),
    run: (command, args, cwd) => current().run(command, args, cwd),
    survivors: (run) => current().survivors(run),
    mark: () => current().mark(),
    carriers: (entry) => current().carriers(entry),
  };
}
