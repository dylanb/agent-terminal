// Build-time placement of the bundled example trees: the packaged app gets them via electron-builder
// extraResources (electron-builder.yml); an unpackaged run reads them from <app.getAppPath()>/example/…,
// so the build must copy the committed trees there. Each destination comes from the runtime resolver
// that reads it back (CLAUDE.md writer↔reader rule).

import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { resolveExampleCommandsDir, resolveExampleFlowDir, resolveExampleLoopsDir } from './exampleAssets';
import { skillNameConflicts } from './exampleSkills';

/** CWE-59: `copyFileSync` FOLLOWS a symlink and materializes the target's bytes as a regular file, so a
 *  link committed under `example/` would be laundered into the bundle — and the install-time walker, which
 *  skips links, would find nothing left to skip and seed the outside content into the user's config. */
function copyTree(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else if (entry.isFile()) copyFileSync(from, to);
    else throw new Error(`Bundled example trees must hold only directories and regular files: ${from} is a symbolic link or other special file (CWE-59)`);
  }
}

export function copyExampleFlow(rootDir: string, mainOutDir: string): string {
  const dest = resolveExampleFlowDir({ packaged: false, appPath: mainOutDir });
  copyTree(path.join(rootDir, 'example', 'flow'), dest);
  return dest;
}

export function copyExampleLoops(rootDir: string, mainOutDir: string): string {
  const src = path.join(rootDir, 'example', 'loops');
  const conflicts = skillNameConflicts(src);
  if (conflicts.length > 0) {
    const detail = conflicts.map((c) => `${c.name} (${c.loops.join(', ')})`).join('; ');
    throw new Error(`Bundled loops ship colliding skill names that would collapse on install (§26.5): ${detail}`);
  }
  const dest = resolveExampleLoopsDir({ packaged: false, appPath: mainOutDir });
  copyTree(src, dest);
  return dest;
}

export function copyExampleCommands(rootDir: string, mainOutDir: string): string {
  const dest = resolveExampleCommandsDir({ packaged: false, appPath: mainOutDir });
  copyTree(path.join(rootDir, 'example', 'commands'), dest);
  return dest;
}
