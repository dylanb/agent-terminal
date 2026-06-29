import path from 'node:path';

export interface IconLocation {
  packaged: boolean;
  resourcesPath: string;
  appPath: string;
}

export function resolveWindowIconPath(loc: IconLocation): string {
  return loc.packaged
    ? path.join(loc.resourcesPath, 'icon.png')
    : path.join(loc.appPath, 'build', 'icon.png');
}

/** The Dock / CMD-TAB icon path, or null off macOS where `app.dock` does not exist. macOS ignores
 *  `BrowserWindow.icon` for the Dock, so it must be set explicitly via `app.dock.setIcon`. */
export function resolveDockIconPath(platform: NodeJS.Platform, loc: IconLocation): string | null {
  return platform === 'darwin' ? resolveWindowIconPath(loc) : null;
}

export interface DockIconTarget {
  setIcon(image: string): void;
}

export function applyDockIcon(
  dock: DockIconTarget | undefined,
  platform: NodeJS.Platform,
  loc: IconLocation,
): void {
  const iconPath = resolveDockIconPath(platform, loc);
  if (!iconPath || !dock) return;
  // The Dock icon is cosmetic; setIcon throws synchronously on an unreadable image, and this runs
  // inside createWindow before the BrowserWindow exists — so a throw here must never abort the window.
  try {
    dock.setIcon(iconPath);
  } catch {
    /* missing/bad icon: skip the Dock icon, never block window creation */
  }
}
