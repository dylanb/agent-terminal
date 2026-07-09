// Build-time placement of the bundled example flow: the packaged app gets example/flow via
// electron-builder extraResources (electron-builder.yml); an unpackaged run reads it from
// <app.getAppPath()>/example/flow, so the build must copy the committed tree there.

import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { resolveExampleFlowDir } from './exampleAssets';

// copyFileSync overwrites in place; a rerun over the Podman e2e mount cannot re-stat pre-existing
// dirs, so directories are never recreated.
function copyTree(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else copyFileSync(from, to);
  }
}

/** Copy <rootDir>/example/flow to where the unpackaged resolver reads it when app.getAppPath() is
 *  `mainOutDir`. Returns the destination path. */
export function copyExampleFlow(rootDir: string, mainOutDir: string): string {
  const dest = resolveExampleFlowDir({ packaged: false, resourcesPath: '', appPath: mainOutDir });
  copyTree(path.join(rootDir, 'example', 'flow'), dest);
  return dest;
}
