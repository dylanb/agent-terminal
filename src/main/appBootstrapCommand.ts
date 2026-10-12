import { execFile } from 'node:child_process';
import { APP_COMMAND_TIMEOUT_MS, commandEnvironment } from './appCommand';

export class CommandFailure extends Error {
  constructor(message: string, readonly exitCode: string | number | undefined) {
    super(message);
  }
}

export interface RunOptions {
  env?: Record<string, string>;
  signal?: AbortSignal;
}

function commandFailureFrom(failure: string, err: { code?: string | number | null }): CommandFailure {
  const code = typeof err.code === 'number' ? ` (exit ${err.code})` : '';
  return new CommandFailure(`${failure}${code}`, err.code ?? undefined);
}

/** Run a command, returning stdout decoded as UTF-8 (lossy) — for ASCII/text output such as SHAs and modes. */
export function run(
  file: string,
  args: string[],
  cwd: string,
  failure: string,
  { env, signal }: RunOptions = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const environment = env ? { ...commandEnvironment(), ...env } : commandEnvironment();
    execFile(file, args, { cwd, timeout: APP_COMMAND_TIMEOUT_MS, env: environment, signal }, (err, stdout) => {
      if (err) reject(commandFailureFrom(failure, err));
      else resolve(stdout);
    });
  });
}

/** Run a command, returning stdout as raw BYTES — for output carrying pathname bytes git does not guarantee
 *  are UTF-8 (a `-z` diff), where the caller must decode strictly rather than let a lossy decode alter paths. */
export function runBuffer(
  file: string,
  args: string[],
  cwd: string,
  failure: string,
  { env, signal }: RunOptions = {},
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const environment = env ? { ...commandEnvironment(), ...env } : commandEnvironment();
    execFile(file, args, { cwd, timeout: APP_COMMAND_TIMEOUT_MS, env: environment, encoding: 'buffer', signal }, (err, stdout) => {
      if (err) reject(commandFailureFrom(failure, err));
      else resolve(stdout as Buffer);
    });
  });
}
