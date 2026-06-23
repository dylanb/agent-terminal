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
