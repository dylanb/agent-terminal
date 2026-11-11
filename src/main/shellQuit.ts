// node-pty delivers the shell's exit through a thread-safe callback into JS. If that callback lands while the
// app is tearing its JS environment down, the call fails and node-pty aborts the process (`terminate called
// after throwing an instance of 'Napi::Error'`), so the app holds its quit until the exit has been delivered,
// or until a kill of the shell has failed.

import { isErrno } from './errno';

export interface QuittingShell {
  exited(): boolean;
  onExit(run: () => void): void;
  forceKill(): 'signalled' | 'failed';
}

export type QuitTimer = (ms: number, run: () => void) => void;

export function holdQuitForShell(
  shell: QuittingShell,
  graceMs: number,
  after: QuitTimer,
  quit: () => void,
): (event: { preventDefault(): void }) => void {
  let waiting = false;
  let released = false;
  return (event) => {
    if (released || shell.exited()) return;
    event.preventDefault();
    if (waiting) return;
    waiting = true;
    shell.onExit(quit);
    after(graceMs, () => {
      if (shell.exited() || shell.forceKill() === 'signalled') return;
      released = true;
      quit();
    });
  };
}

export function killShell(kill: () => void): 'signalled' | 'failed' {
  try {
    kill();
  } catch (error) {
    if (!isErrno(error, 'ESRCH')) return 'failed';
  }
  return 'signalled';
}
