import { describe, expect, it } from 'vitest';
import { shouldTerminateOnShellExit } from '../../src/main/shellExit';

// The hosted shell IS the session (§5): its exit terminates the app — EXCEPT an immediate
// startup failure (a broken rc / bad APP_SHELL / instant crash), which keeps the window open so
// the `[process exited]` diagnostic is visible instead of the app flashing and vanishing. The
// boundary is the shell's uptime at exit vs the startup grace window.
describe('shouldTerminateOnShellExit (§5 startup-failure exception)', () => {
  it('keeps the app open when the shell exits within the grace window (startup failure)', () => {
    expect(shouldTerminateOnShellExit(0, 1000)).toBe(false);
    expect(shouldTerminateOnShellExit(999, 1000)).toBe(false);
  });

  it('terminates the app when the shell ran to or past the grace window (normal session end)', () => {
    expect(shouldTerminateOnShellExit(1000, 1000)).toBe(true);
    expect(shouldTerminateOnShellExit(5000, 1000)).toBe(true);
  });
});
