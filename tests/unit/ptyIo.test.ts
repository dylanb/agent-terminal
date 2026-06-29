import { describe, it, expect } from 'vitest';
import { createPtyIo, type PtyIo } from '../../src/main/ptyIo';

function fakePty(): PtyIo & { writes: string[]; resizes: Array<[number, number]> } {
  const writes: string[] = [];
  const resizes: Array<[number, number]> = [];
  return {
    writes,
    resizes,
    write: (d) => writes.push(d),
    resize: (c, r) => resizes.push([c, r]),
  };
}

describe('createPtyIo — PTY I/O that goes silent once the shell exits (§5)', () => {
  it('forwards write and resize to the live shell before it exits', () => {
    const pty = fakePty();
    const { io } = createPtyIo(pty);
    io.write('ls\n');
    io.resize(120, 40);
    expect(pty.writes).toEqual(['ls\n']);
    expect(pty.resizes).toEqual([[120, 40]]);
  });

  it('drops write and resize after the shell has exited so a dead master fd is never touched', () => {
    // A resize/write on a closed PTY master fd throws ioctl EBADF; uncaught in the main process that
    // pops Electron's modal error dialog and wedges the app. After exit the I/O must be a no-op.
    const pty = fakePty();
    const { io, markExited } = createPtyIo(pty);
    markExited();
    io.write('after-exit\n');
    io.resize(80, 24);
    expect(pty.writes).toEqual([]);
    expect(pty.resizes).toEqual([]);
  });

  it('never propagates a throw from the underlying PTY (the exit-race window before onExit fires)', () => {
    // The master fd can already be dead in the gap between the child exiting and node-pty delivering
    // onExit. A write/resize landing in that window throws EBADF; the guard must swallow it, not crash.
    const throwing: PtyIo = {
      write: () => {
        throw new Error('ioctl(2) failed, EBADF');
      },
      resize: () => {
        throw new Error('ioctl(2) failed, EBADF');
      },
    };
    const { io } = createPtyIo(throwing);
    expect(() => io.write('x')).not.toThrow();
    expect(() => io.resize(1, 1)).not.toThrow();
  });
});
