import { execFileSync } from 'node:child_process';
import { shellQuote } from '../../src/shared/shellQuote';

const has = (tool: string): boolean => {
  try {
    execFileSync('sh', ['-c', 'command -v "$1"', 'sh', tool], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

/** How to run `argv` on a terminal of its own from a test (node-pty is built for Electron's ABI and does not load
 *  under vitest), with piped stdin copied in; `null` when this machine has no allocator. util-linux
 *  `script -qec '<cmd>' <file>` creates the terminal from a piped stdin, but BSD/macOS `script` accepts neither `-c`
 *  nor a non-tty stdin, so on darwin Python's `pty.spawn` allocates it. */
export function ptyCommand(argv: string[], platform: NodeJS.Platform = process.platform): { file: string; args: string[] } | null {
  if (platform === 'darwin') return has('python3') ? { file: 'python3', args: ['-c', 'import os, pty, sys; sys.exit(os.waitstatus_to_exitcode(pty.spawn(sys.argv[1:])))', ...argv] } : null;
  return has('script') ? { file: 'script', args: ['-qec', argv.map(shellQuote).join(' '), '/dev/null'] } : null;
}
