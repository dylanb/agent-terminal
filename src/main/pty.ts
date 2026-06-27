// Shell spawn configuration (§5).

import { execFile } from 'node:child_process';
import * as pty from 'node-pty';
import { APP_LAUNCH_DIR_ENV } from './launchRoot';

export interface SpawnConfig {
  shellPath: string;
  shellArgs: string[];
  options: {
    name: string;
    cols: number;
    rows: number;
    cwd: string;
    env: Record<string, string>;
  };
}

/** Resolve a shell path: `APP_SHELL`, else `$SHELL`, else `loginShell`, else `bash` (§5, v2.79).
 *  `loginShell` is an optional caller-supplied fallback, NOT always consulted: the session-spawn
 *  callers omit it (a no-`$SHELL` GUI session falls through to `bash`), while the installer passes
 *  the passwd-db login shell so a no-`$SHELL` GUI launch edits the profile that shell actually
 *  sources. The two callers therefore diverge by design in the no-`$SHELL` case — keep them distinct. */
export function resolveShellPath(env: NodeJS.ProcessEnv, loginShell?: string): string {
  return env.APP_SHELL || env.SHELL || loginShell || 'bash';
}

/** True when the shell is bash (the only shell whose OSC-133 hooks we install, §15.5). */
function isBashShell(shellPath: string): boolean {
  return /(^|\/)bash$/.test(shellPath);
}

export function buildSpawnConfig(input: {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** The resolved launch root (§23.4): where the shell is spawned, one value per process. */
  cwd: string;
  probedPath?: string;
  /** App-owned, non-user-writable path to the sourced integration script (§15.5 / D3). */
  integrationScriptPath?: string;
}): SpawnConfig {
  const { platform, env, cwd, probedPath, integrationScriptPath } = input;
  const cleanEnv = Object.fromEntries(
    Object.entries(env).filter(
      (e): e is [string, string] => e[1] !== undefined && e[0] !== APP_LAUNCH_DIR_ENV,
    ),
  );
  const shellPath = resolveShellPath(env);

  // Source the integration script after the user's startup files via the only
  // post-rc env seam bash exposes — PROMPT_COMMAND. Opt-out: APP_SHELL_INTEGRATION=0
  // or a non-bash shell (§15.5).
  const integrate =
    !!integrationScriptPath && env.APP_SHELL_INTEGRATION !== '0' && isBashShell(shellPath);
  const integrationEnv: Record<string, string> = integrate
    ? {
        APP_TERM_INTEGRATION: integrationScriptPath as string,
        PROMPT_COMMAND: `source "${integrationScriptPath}"`,
      }
    : {};

  return {
    shellPath,
    // Login shell on macOS (native terminals' convention), plain interactive on Linux (§5).
    shellArgs: platform === 'darwin' ? ['-l'] : [],
    options: {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd,
      env: {
        ...cleanEnv,
        ...(probedPath ? { PATH: probedPath } : {}),
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        ...integrationEnv,
      },
    },
  };
}

/** Union of two PATHs: inherited entries keep their precedence, probed-only entries append. */
export function mergePaths(currentPath: string, probedPath: string): string {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const entry of [...currentPath.split(':'), ...probedPath.split(':')]) {
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    merged.push(entry);
  }
  return merged.join(':');
}

/** The Linux GUI-launch PATH probe command (§5, v2.82), or undefined off Linux (macOS recovers
 *  PATH via the `-l` login shell). Targets the resolved session shell so the probed PATH matches
 *  the shell the session runs. */
export function probeShellCommand(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): { file: string; args: string[] } | undefined {
  if (platform !== 'linux') return undefined;
  return { file: resolveShellPath(env), args: ['-l', '-c', 'echo -n "$PATH"'] };
}

/**
 * GUI launches inherit a barren PATH (§5). On Linux, probe the user's login shell once
 * and merge its PATH with ours when it adds entries — never replacing inherited ones
 * (an active venv/direnv). macOS is covered by the -l shell.
 */
export function probeLoginPath(): Promise<string | undefined> {
  const cmd = probeShellCommand(process.platform, process.env);
  if (!cmd) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile(cmd.file, cmd.args, { timeout: 5000 }, (err, stdout) => {
      if (err || !stdout) return resolve(undefined);
      const current = process.env.PATH ?? '';
      const probed = stdout.trim();
      const currentEntries = new Set(current.split(':'));
      const hasNewEntries = probed.split(':').some((p) => p && !currentEntries.has(p));
      resolve(hasNewEntries ? mergePaths(current, probed) : undefined);
    });
  });
}

export async function spawnAgentShell(opts: {
  integrationScriptPath?: string;
  cwd: string;
}): Promise<pty.IPty> {
  const probedPath = await probeLoginPath();
  const cfg = buildSpawnConfig({
    platform: process.platform,
    env: process.env,
    cwd: opts.cwd,
    probedPath,
    integrationScriptPath: opts.integrationScriptPath,
  });
  return pty.spawn(cfg.shellPath, cfg.shellArgs, cfg.options);
}
