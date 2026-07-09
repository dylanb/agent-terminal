// Build-time icon placement (not a runtime path). The packaged app gets build/icon.png via
// electron-builder extraResources (electron-builder.yml); an UNPACKAGED built run (e2e / `pnpm run
// dev`) instead reads it from <app.getAppPath()>/build/icon.png, and app.getAppPath() is the main out
// dir — so the build must copy the committed icon there or dock.setIcon fails. Reusing
// resolveWindowIconPath as the destination keeps this copy and the runtime read from ever drifting.

import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { resolveWindowIconPath } from './appIcon';

/** Copy <rootDir>/build/icon.png to where the unpackaged resolver reads it when app.getAppPath() is
 *  `mainOutDir`. Returns the destination path. */
export function copyDevIcon(rootDir: string, mainOutDir: string): string {
  const src = path.join(rootDir, 'build', 'icon.png');
  const dest = resolveWindowIconPath({ packaged: false, appPath: mainOutDir });
  mkdirSync(path.dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  return dest;
}
