// Navigation lockdown (Electron security checklist 13/14). The preload bridge
// exposes PTY-writing APIs to whatever document the window holds, so the window
// must never navigate away from the bundled renderer or spawn child windows.

export function denyWindowOpen(): { action: 'deny' } {
  return { action: 'deny' };
}

export function preventForeignNavigation(event: { preventDefault(): void }): void {
  event.preventDefault();
}

interface NavigationGuardTarget {
  on(event: string, listener: (event: { preventDefault(): void }) => void): unknown;
  setWindowOpenHandler(handler: () => { action: 'deny' }): unknown;
}

/**
 * Lock down a webContents: deny child windows and cancel any navigation away from
 * the bundled renderer. Both `will-navigate` and `will-redirect` are guarded — a
 * server-side/HTTP redirect fires only the latter (Electron checklist 13).
 */
export function installNavigationGuards(target: NavigationGuardTarget): void {
  target.setWindowOpenHandler(denyWindowOpen);
  target.on('will-navigate', preventForeignNavigation);
  target.on('will-redirect', preventForeignNavigation);
}
