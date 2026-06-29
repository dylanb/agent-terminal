// PTY input/output that goes silent once the hosted shell exits (§5). The session can outlive its
// shell: on a sub-grace exit the window stays open so the user can read the `[process exited]`
// diagnostic, but the renderer keeps emitting resize (xterm fit / ResizeObserver) and input. Driving
// the shell's now-closed master fd makes node-pty throw `ioctl(2) failed, EBADF`; uncaught in the
// main process that raises Electron's modal error dialog, which blocks the event loop and wedges quit.

/** The narrow slice of the PTY this guard drives — just the two operations that hit the master fd. */
export interface PtyIo {
  write(data: string): void;
  resize(cols: number, rows: number): void;
}

/** Wrap PTY I/O so that, once the shell has exited, `write`/`resize` are no-ops, and a throw from the
 *  underlying PTY (the exit-race window before `onExit` is delivered) is swallowed rather than crashing
 *  the main process. `markExited` is the authoritative signal, wired to the shell's `onExit`. */
export function createPtyIo(pty: PtyIo): { io: PtyIo; markExited(): void } {
  let exited = false;
  const guard = (op: () => void): void => {
    if (exited) return;
    try {
      op();
    } catch {
      // The fd is already gone (child exited just before onExit fired); dropping it is the §5 behavior.
    }
  };
  return {
    io: {
      write: (data) => guard(() => pty.write(data)),
      resize: (cols, rows) => guard(() => pty.resize(cols, rows)),
    },
    markExited: () => {
      exited = true;
    },
  };
}
