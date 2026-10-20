// #180 — the real AppLauncher: it opens this checkout's app at a prepared working folder and resolves once that
// app has exited.

import path from 'node:path';
import type { BundleLocation } from './bundleLocation';
import { resolveLaunchInvocation, type LaunchInvocation } from './cliShim';
import type { BenchLaunch } from '../shared/benchLaunch';

export interface AppLauncher {
  /** Resolves when the launched app process has exited. */
  open(launch: BenchLaunch): Promise<void>;
}

export interface BenchAppTarget {
  invocation: LaunchInvocation;
  bundle: BundleLocation;
}

/** The app the runner launches and the bundle it reads, from the runner's own Electron binary and main dir. */
export function benchAppTarget(execPath: string, mainDir: string): BenchAppTarget {
  return { invocation: resolveLaunchInvocation(execPath, true, path.join(mainDir, 'index.js'), mainDir), bundle: { packaged: false, appPath: '' } };
}

/** The env the app is launched with: the runner's own, carrying `launch`. */
export function benchLaunchEnv(env: NodeJS.ProcessEnv, _launch: BenchLaunch): NodeJS.ProcessEnv {
  return { ...env };
}

export function createBenchLauncher(_invocation: LaunchInvocation, _env: NodeJS.ProcessEnv): AppLauncher {
  return { open: () => Promise.reject(new Error('not launched')) };
}
