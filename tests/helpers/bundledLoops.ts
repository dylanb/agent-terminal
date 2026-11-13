// §27.8 — `example/loops-v2/<flow>/<loop>/` or the shared `example/loops-v2/<loop>/`.

import { relative, resolve } from 'node:path';
import { listLoopFolders, type LoopFolder } from '../../src/main/loopFolders';
import { resolveLoopDefV2, type LoopDefV2Result } from '../../src/main/loopDefV2';
import { resolveExampleLoopsV2Dir } from '../../src/main/exampleAssets';

export const REPO_DIR = resolve(__dirname, '..', '..');
export const BUNDLED_LOOPS_ROOT = resolveExampleLoopsV2Dir({ packaged: false, appPath: REPO_DIR });

function bundledFolderOf(loop: string): LoopFolder {
  const folder = listLoopFolders(BUNDLED_LOOPS_ROOT).find((f) => f.name === loop);
  if (folder === undefined) throw new Error(`no bundled loop ${loop}`);
  return folder;
}

export function bundledFlowOf(loop: string): string | undefined {
  return bundledFolderOf(loop).flow ?? undefined;
}

export function bundledLoopRel(loop: string): string {
  return relative(BUNDLED_LOOPS_ROOT, bundledFolderOf(loop).dir);
}

export function bundledLoopDir(loop: string): string {
  return bundledFolderOf(loop).dir;
}

export function resolveBundledLoop(loop: string): LoopDefV2Result {
  return resolveLoopDefV2(loop, {
    tiers: { operator: null, appBundled: BUNDLED_LOOPS_ROOT, retired: null },
    repoDir: REPO_DIR,
    flow: bundledFlowOf(loop),
  });
}
