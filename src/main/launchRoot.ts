// Launch-root resolution (§23.4).

import fs from 'node:fs';

/** F (§23.4): `$HOME`, else the OS home dir — the value the launch root falls back to. */
export function homeFallback(env: NodeJS.ProcessEnv, home: string): string {
  return env.HOME || home;
}

/** Whether a real, existing directory can be entered — the §23.4 "enterable directory" criterion.
 *  Injectable so the not-enterable branch is testable where a real fixture cannot provoke it (CI runs
 *  as root, where the traverse check always passes). */
export type CanEnter = (dir: string) => boolean;

const canEnterDefault: CanEnter = (dir) => {
  try {
    fs.accessSync(dir, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** The OS-boundary env var carrying the caller-supplied launch target (§23.4). */
export const APP_LAUNCH_DIR_ENV = 'APP_LAUNCH_DIR';

/**
 * The validated launch root (§23.4): the caller-supplied `target` resolved to its real path when it
 * is an enterable directory, else `fallback` (F) returned verbatim.
 */
export function resolveLaunchRoot(
  target: string | undefined,
  fallback: string,
  canEnter: CanEnter = canEnterDefault,
): string {
  if (!target) return fallback;
  try {
    const real = fs.realpathSync(target);
    if (!fs.statSync(real).isDirectory()) return fallback;
    if (!canEnter(real)) return fallback;
    return real;
  } catch {
    return fallback;
  }
}

/** The per-process launch surfaces (§23.4): `launchRoot` (L) anchors the cwd surfaces — PTY shell cwd
 *  (§5), artifact-viewer fallback root (§20.1), and todo/repo-scope fallback (§16.3). `flowGlobalDir`
 *  is where the GLOBAL flow definition lives (§18.1): the per-user home (F), NOT L — the local-first
 *  repo tier already covers a launch-at-a-repo, so a global flow at ~/.agent-terminal/flow.yaml must
 *  resolve regardless of the launch target rather than be shadowed by it. */
export interface LaunchSurfaces {
  launchRoot: string;
  flowGlobalDir: string;
}

export function resolveLaunchSurfaces(
  env: NodeJS.ProcessEnv,
  osHome: string,
  canEnter: CanEnter = canEnterDefault,
): LaunchSurfaces {
  const home = homeFallback(env, osHome);
  return {
    launchRoot: resolveLaunchRoot(env[APP_LAUNCH_DIR_ENV], home, canEnter),
    flowGlobalDir: home,
  };
}
