import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';
import type { McpTmux } from '../shared/mcpBridge';

export function runTmux(tmux: McpTmux, args: string[], input?: string): string {
  const directories = tmux.searchPath.split(path.delimiter).filter(directory => path.isAbsolute(directory));
  const executable = directories.map(directory => path.join(directory, 'tmux')).find(candidate => {
    try { accessSync(candidate, constants.X_OK); return statSync(candidate).isFile(); } catch { return false; }
  });
  if (executable === undefined) throw new Error('tmux was not found on an absolute executable search path.');
  const options: ExecFileSyncOptionsWithStringEncoding = {
    encoding: 'utf8', timeout: 1000, input,
    env: { ...process.env, PATH: directories.join(path.delimiter) },
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'],
  };
  return execFileSync(executable, ['-S', tmux.socket, ...args], options);
}
