// Window teardown (§5): each dispose step is best-effort. A shell that already exited — the §5
// startup-grace state where the window is deliberately kept open after `pty:exit` — makes
// `ptyProcess.kill()` throw ESRCH; that throw must not abort the remaining steps, or the
// fs-watchers/timers never release and the process hangs on shutdown (CLAUDE.md
// best-effort-side-effect rule).
export function disposeAll(steps: ReadonlyArray<() => void>): void {
  for (const step of steps) {
    try {
      step();
    } catch {
      /* a failing teardown step must not abort the others */
    }
  }
}
