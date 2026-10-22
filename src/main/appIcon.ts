import path from 'node:path';
import type { BundleLocation } from './bundleLocation';

export type IconLocation = BundleLocation;

export type AppIcon = 'terminal' | 'controller';

const ICON_FILES: Record<AppIcon, string> = { terminal: 'icon.png', controller: 'controller-icon.png' };

export function resolveWindowIconPath(loc: IconLocation, icon: AppIcon): string {
  return loc.packaged
    ? path.join(loc.resourcesPath, ICON_FILES[icon])
    : path.join(loc.appPath, 'build', ICON_FILES[icon]);
}

/** The Dock / CMD-TAB icon path, or null off macOS where `app.dock` does not exist. macOS ignores
 *  `BrowserWindow.icon` for the Dock, so it must be set explicitly via `app.dock.setIcon`. */
export function resolveDockIconPath(platform: NodeJS.Platform, loc: IconLocation, icon: AppIcon): string | null {
  return platform === 'darwin' ? resolveWindowIconPath(loc, icon) : null;
}

export interface DockIconTarget {
  setIcon(image: string): void;
}

export function applyDockIcon(
  dock: DockIconTarget | undefined,
  platform: NodeJS.Platform,
  loc: IconLocation,
  icon: AppIcon,
): void {
  const iconPath = resolveDockIconPath(platform, loc, icon);
  if (!iconPath || !dock) return;
  // The Dock icon is cosmetic; setIcon throws synchronously on an unreadable image, and this runs
  // inside createWindow before the BrowserWindow exists — so a throw here must never abort the window.
  try {
    dock.setIcon(iconPath);
  } catch {
    /* missing/bad icon: skip the Dock icon, never block window creation */
  }
}
