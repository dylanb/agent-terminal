import { spawn } from 'node:child_process';
import path from 'node:path';
import type { BundleLocation } from './bundleLocation';
import { resolveLaunchInvocation, type LaunchInvocation } from './cliShim';
import { errMsg } from './errno';
import { APP_LAUNCH_DIR_ENV } from './launchRoot';
import { BENCH_LAUNCH_ENV, encodeBenchLaunch, type BenchLaunch } from '../shared/benchLaunch';

export type AppRun = { started: true } | { started: false; error: string };

export interface AppLauncher {
  /** Resolves when the launched app process has exited, or could not be started, and never rejects. */
  open(launch: BenchLaunch): Promise<AppRun>;
}

export interface BenchAppTarget {
  invocation: LaunchInvocation;
  bundle: BundleLocation;
}

/** The app the runner launches and the bundle it reads, from the runner's own Electron binary and main dir: the
 *  unpackaged app whose `app.getAppPath()` is that main dir (§23.5). */
export function benchAppTarget(execPath: string, mainDir: string): BenchAppTarget {
  return {
    invocation: resolveLaunchInvocation(execPath, true, path.join(mainDir, 'index.js'), mainDir),
    bundle: { packaged: false, appPath: mainDir },
  };
}

/** §23.4 */
export function benchLaunchEnv(env: NodeJS.ProcessEnv, launch: BenchLaunch): NodeJS.ProcessEnv {
  const { ELECTRON_RUN_AS_NODE: _plainNode, ...rest } = env;
  return { ...rest, [APP_LAUNCH_DIR_ENV]: launch.workingFolder, [BENCH_LAUNCH_ENV]: encodeBenchLaunch(launch) };
}

export function createBenchLauncher(invocation: LaunchInvocation, env: NodeJS.ProcessEnv): AppLauncher {
  return {
    open: (launch) =>
      new Promise<AppRun>((resolve) => {
        const child = spawn(invocation.execPath, invocation.appArgs, {
          cwd: launch.workingFolder,
          env: benchLaunchEnv(env, launch),
          stdio: ['ignore', 'ignore', 'inherit'],
        });
        child.once('error', (e) => resolve({ started: false, error: errMsg(e) }));
        child.once('exit', () => resolve({ started: true }));
      }),
  };
}
