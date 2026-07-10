// Build-time placement of the bundled example trees: the packaged app gets them via electron-builder
// extraResources (electron-builder.yml); an unpackaged run reads them from <app.getAppPath()>/example/…,
// so the build must copy the committed trees there. Each destination comes from the runtime resolver
// that reads it back (CLAUDE.md writer↔reader rule).

import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { resolveExampleCommandsDir, resolveExampleFlowDir, resolveExampleLoopsDir } from './exampleAssets';

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
  const dest = resolveExampleFlowDir({ packaged: false, appPath: mainOutDir });
  copyTree(path.join(rootDir, 'example', 'flow'), dest);
  return dest;
}

/** Copy <rootDir>/example/loops to where the unpackaged resolver reads it. Returns the destination. */
export function copyExampleLoops(rootDir: string, mainOutDir: string): string {
  const dest = resolveExampleLoopsDir({ packaged: false, appPath: mainOutDir });
  copyTree(path.join(rootDir, 'example', 'loops'), dest);
  return dest;
}

/** Copy <rootDir>/example/commands to where the unpackaged resolver reads it. Returns the destination. */
export function copyExampleCommands(rootDir: string, mainOutDir: string): string {
  const dest = resolveExampleCommandsDir({ packaged: false, appPath: mainOutDir });
  copyTree(path.join(rootDir, 'example', 'commands'), dest);
  return dest;
}
