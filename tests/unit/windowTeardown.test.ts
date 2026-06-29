import { describe, expect, it, vi } from 'vitest';
import { disposeAll } from '../../src/main/windowTeardown';

// Window teardown (§5): when the window closes, every dispose step must run even if one throws — a
// shell that already exited (the grace-kept-open state) makes ptyProcess.kill() throw ESRCH, and if
// that aborts the rest of teardown the fs-watchers/timers leak and the process never exits, hanging
// the next launch's shutdown.
describe('disposeAll — best-effort window teardown', () => {
  it('runs every step even when an earlier step throws', () => {
    const calls: string[] = [];
    disposeAll([
      () => calls.push('a'),
      () => {
        throw new Error('kill: ESRCH (shell already exited)');
      },
      () => calls.push('c'),
    ]);
    expect(calls).toEqual(['a', 'c']);
  });

  it('does not itself throw when a step throws, and still runs the remaining steps', () => {
    const last = vi.fn();
    expect(() =>
      disposeAll([
        () => {
          throw new Error('boom');
        },
        last,
      ]),
    ).not.toThrow();
    expect(last).toHaveBeenCalledTimes(1);
  });
});
