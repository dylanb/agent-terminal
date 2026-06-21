// Reveal the loop read-out (§24.2.3 T4) — the renderer's response to main's flow:revealLoop push
// (the OS notification was activated). Lands the user on the read-out in every case by binding to the
// shipped Shell seams: exit viewer-fullscreen if active (§20.2 hides the rail/loop-panel chrome),
// switch to the Terminal view, then open the docked loop read-out — all through the typed interface,
// never by DOM reach-across.

import type { Shell } from './shell';

/** Exit viewer-fullscreen, switch to the Terminal view, and open the docked loop read-out. */
export function revealLoopReadout(shell: Shell): void {
  shell.setViewerFullscreen(false);
  shell.setView('1');
  shell.openLoopPanel();
}
