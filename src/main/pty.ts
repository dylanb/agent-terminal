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

export function buildSpawnConfig(input: {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  probedPath?: string;
}): SpawnConfig {
  const { platform, env, home, probedPath } = input;
  const cleanEnv = Object.fromEntries(
    Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined),
  );
  return {
    shellPath: env.APP_SHELL || 'bash',
    // Login shell on macOS (native terminals' convention), plain interactive on Linux (§5).
    shellArgs: platform === 'darwin' ? ['-l'] : [],
    options: {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: env.HOME || home,
      env: {
        ...cleanEnv,
        ...(probedPath ? { PATH: probedPath } : {}),
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      },
    },
  };
}

/**
 * GUI launches inherit a barren PATH (§5). On Linux, probe a login shell once and
 * use its PATH when it is broader than ours; macOS is covered by the -l shell.
 */
export function probeLoginPath(): Promise<string | undefined> {
  if (process.platform !== 'linux') return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile('bash', ['-lc', 'echo -n "$PATH"'], { timeout: 5000 }, (err, stdout) => {
      if (err || !stdout) return resolve(undefined);
      const current = new Set((process.env.PATH ?? '').split(':'));
      const probed = stdout.trim();
      const hasNewEntries = probed.split(':').some((p) => p && !current.has(p));
      resolve(hasNewEntries ? probed : undefined);
    });
  });
}

export async function spawnAgentShell(): Promise<pty.IPty> {
  const probedPath = await probeLoginPath();
  const cfg = buildSpawnConfig({
    platform: process.platform,
    env: process.env,
    home: os.homedir(),
    probedPath,
  });
  return pty.spawn(cfg.shellPath, cfg.shellArgs, cfg.options);
}
