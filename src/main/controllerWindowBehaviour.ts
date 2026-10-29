import type { BrowserWindow, Rectangle } from 'electron';
import type { ControllerCloseAction } from './controllerWindowPolicy';

export interface ControllerWindowBehaviourDeps {
  closeAction: ControllerCloseAction;
  quitting(): boolean;
  saveBounds(bounds: Rectangle): void;
}

export interface ControllerWindowBehaviour {
  open(): void;
}

export function installControllerWindowBehaviour(window: BrowserWindow, deps: ControllerWindowBehaviourDeps): ControllerWindowBehaviour {
  // Window managers that animate minimizing by sliding the frame (openbox) make Chromium report each step as a move,
  // so a minimized window's own bounds are not where the operator left it.
  let boundsBeforeMinimize: Rectangle | null = null;
  window.on('minimize', () => { boundsBeforeMinimize = window.getNormalBounds(); });
  window.on('restore', () => { boundsBeforeMinimize = null; });
  // untestable (macOS hide-on-close is native) — tracked in #153.
  const putAway = () => {
    switch (deps.closeAction) {
      case 'hide': window.hide(); return;
      case 'minimize': window.minimize(); return;
    }
  };
  window.on('close', event => {
    if (deps.quitting()) {
      deps.saveBounds(boundsBeforeMinimize ?? window.getNormalBounds());
      return;
    }
    event.preventDefault();
    // A full-screen window ignores minimize, and hiding one on macOS leaves its Space behind as a black screen.
    if (!window.isFullScreen()) {
      putAway();
      return;
    }
    window.once('leave-full-screen', putAway);
    window.setFullScreen(false);
  });
  return {
    open() {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    },
  };
}
