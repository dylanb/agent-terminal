// Bash spawn configuration (§5): platform-correct startup files, xterm-256color
// terminfo, inherited env, APP_SHELL override, GUI-launch PATH probe fallback.

import { execFile } from 'node:child_process';
import os from 'node:os';
import * as pty from 'node-pty';

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

/** True when the shell is bash (the only shell whose OSC-133 hooks we install, §15.5). */
function isBashShell(shellPath: string): boolean {
  return /(^|\/)bash$/.test(shellPath);
}

/** The directory bash is spawned in (§5): $HOME, else the home arg. Also the artifact
 *  viewer's cwd fallback before the first OSC 7 (§20.1) — so the viewer starts where the
 *  terminal starts, not in the Electron process dir. */
export function spawnCwd(env: NodeJS.ProcessEnv, home: string): string {
  return env.HOME || home;
}

export function buildSpawnConfig(input: {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  probedPath?: string;
  /** App-owned, non-user-writable path to the sourced integration script (§15.5 / D3). */
  integrationScriptPath?: string;
}): SpawnConfig {
  const { platform, env, home, probedPath, integrationScriptPath } = input;
  const cleanEnv = Object.fromEntries(
    Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined),
  );
  const shellPath = env.APP_SHELL || 'bash';

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
      cwd: spawnCwd(env, home),
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

/**
 * GUI launches inherit a barren PATH (§5). On Linux, probe a login shell once and
 * merge its PATH with ours when it adds entries — never replacing inherited ones
 * (an active venv/direnv). macOS is covered by the -l shell.
 */
export function probeLoginPath(): Promise<string | undefined> {
  if (process.platform !== 'linux') return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile('bash', ['-lc', 'echo -n "$PATH"'], { timeout: 5000 }, (err, stdout) => {
      if (err || !stdout) return resolve(undefined);
      const current = process.env.PATH ?? '';
      const probed = stdout.trim();
      const currentEntries = new Set(current.split(':'));
      const hasNewEntries = probed.split(':').some((p) => p && !currentEntries.has(p));
      resolve(hasNewEntries ? mergePaths(current, probed) : undefined);
    });
  });
}

export async function spawnAgentShell(opts: { integrationScriptPath?: string } = {}): Promise<pty.IPty> {
  const probedPath = await probeLoginPath();
  const cfg = buildSpawnConfig({
    platform: process.platform,
    env: process.env,
    home: os.homedir(),
    probedPath,
    integrationScriptPath: opts.integrationScriptPath,
  });
  return pty.spawn(cfg.shellPath, cfg.shellArgs, cfg.options);
}
