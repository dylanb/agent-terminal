// Reveal the loop read-out (§24.2.3 T4): the renderer's response to main's flow:revealLoop.

import type { Shell } from './shell';

export function revealLoopReadout(shell: Shell): void {
  shell.setViewerFullscreen(false); // first: it hides the rail/loop-panel chrome the read-out lives in (§20.2)
  shell.setView('1');
  shell.openLoopPanel();
}
