// Build-time placement of the bundled example flow (not a runtime path). The packaged app gets
// example/flow via electron-builder extraResources (electron-builder.yml); an UNPACKAGED built run
// (e2e / `pnpm run dev`) instead reads it from <app.getAppPath()>/example/flow, and app.getAppPath()
// is the main out dir — so the build must copy the committed tree there. Reusing resolveExampleFlowDir
// as the destination keeps this copy and the runtime read from ever drifting.

import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { resolveExampleFlowDir } from './exampleAssets';

// Overwrite files in place (copyFileSync), never recreate directories — mirrors copyDevIcon so a rerun
// over a populated out/ (e.g. the Podman e2e mount, whose dirs the container cannot re-stat) overwrites
// rather than tripping cp's getStats on a pre-existing subdir.
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
