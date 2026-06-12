// Navigation lockdown (Electron security checklist 13/14). The preload bridge
// exposes PTY-writing APIs to whatever document the window holds, so the window
// must never navigate away from the bundled renderer or spawn child windows.

export function denyWindowOpen(): { action: 'deny' } {
  return { action: 'deny' };
}

export function preventForeignNavigation(event: { preventDefault(): void }): void {
  event.preventDefault();
}
