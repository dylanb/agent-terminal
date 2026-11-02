// Build-time placement of the bundled example trees: the packaged app gets them via electron-builder
// extraResources (electron-builder.yml); an unpackaged run reads them from <app.getAppPath()>/example/…,
// so the build must copy the committed trees there. Each destination comes from the runtime resolver
// that reads it back (CLAUDE.md writer↔reader rule).

import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  resolveExampleCodexSkillsDir,
  resolveExampleCommandsDir,
  resolveExampleFlowsDir,
  resolveExampleLoopsV2Dir,
} from './exampleAssets';

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

export function copyExampleFlows(rootDir: string, mainOutDir: string): string {
  const dest = resolveExampleFlowsDir({ packaged: false, appPath: mainOutDir });
  copyTree(path.join(rootDir, 'example', 'flows'), dest);
  return dest;
}

export function copyExampleLoopsV2(rootDir: string, mainOutDir: string): string {
  const dest = resolveExampleLoopsV2Dir({ packaged: false, appPath: mainOutDir });
  copyTree(path.join(rootDir, 'example', 'loops-v2'), dest);
  return dest;
}

export function copyExampleCommands(rootDir: string, mainOutDir: string): string {
  const dest = resolveExampleCommandsDir({ packaged: false, appPath: mainOutDir });
  copyTree(path.join(rootDir, 'example', 'commands'), dest);
  return dest;
}

export function copyExampleCodexSkills(rootDir: string, mainOutDir: string): string {
  const dest = resolveExampleCodexSkillsDir({ packaged: false, appPath: mainOutDir });
  copyTree(path.join(rootDir, 'example', 'codex-skills'), dest);
  return dest;
}

export function placeExampleAssets(rootDir: string, mainOutDir: string): void {
  copyExampleFlows(rootDir, mainOutDir);
  copyExampleLoopsV2(rootDir, mainOutDir);
  copyExampleCommands(rootDir, mainOutDir);
  copyExampleCodexSkills(rootDir, mainOutDir);
}

export function writeEngineGuide(dir: string): void {
  void dir;
}

export function placeBuildOutputs(rootDir: string, mainOutDir: string): void {
  void rootDir;
  void mainOutDir;
}
