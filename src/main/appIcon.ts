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
