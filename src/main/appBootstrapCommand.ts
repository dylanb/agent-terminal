import { execFile } from 'node:child_process';
import { APP_COMMAND_TIMEOUT_MS, commandEnvironment } from './appCommand';

export class CommandFailure extends Error {
  constructor(message: string, readonly exitCode: string | number | undefined) {
    super(message);
  }
}

export function run(file: string, args: string[], cwd: string, failure: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd, timeout: APP_COMMAND_TIMEOUT_MS, env: commandEnvironment() }, (err, stdout) => {
      if (err) {
        const commandError = err as NodeJS.ErrnoException & {
          killed?: boolean;
          signal?: NodeJS.Signals | null;
        };
        const code =
          typeof commandError.code === 'number'
            ? ` (exit ${commandError.code})`
            : '';
        reject(new CommandFailure(`${failure}${code}`, commandError.code));
      } else resolve(stdout);
    });
  });
}
