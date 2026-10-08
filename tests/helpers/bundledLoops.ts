// §27.8 — `example/loops-v2/<flow>/<loop>/`.

import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveLoopDefV2, type LoopDefV2Result } from '../../src/main/loopDefV2';
import { FEATURE_DEV_ID, resolveExampleLoopsV2Dir } from '../../src/main/exampleAssets';

export const REPO_DIR = resolve(__dirname, '..', '..');
export const BUNDLED_LOOPS_ROOT = resolveExampleLoopsV2Dir({ packaged: false, appPath: REPO_DIR });

function flowFolders(): string[] {
  const others = readdirSync(BUNDLED_LOOPS_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== FEATURE_DEV_ID)
    .map((e) => e.name)
    .sort();
  return [FEATURE_DEV_ID, ...others];
}

export function bundledFlowOf(loop: string): string {
  const flow = flowFolders().find((f) => existsSync(join(BUNDLED_LOOPS_ROOT, f, loop, `${loop}.yaml`)));
  if (flow === undefined) throw new Error(`no bundled flow ships loop ${loop}`);
  return flow;
}

export function bundledLoopDir(loop: string): string {
  return join(BUNDLED_LOOPS_ROOT, bundledFlowOf(loop), loop);
}

export function bundledPath(rel: string): string {
  const [loop, ...rest] = rel.split('/');
  return join(bundledLoopDir(loop), ...rest);
}

export function resolveBundledLoop(loop: string): LoopDefV2Result {
  return resolveLoopDefV2(loop, {
    tiers: { operator: null, appBundled: BUNDLED_LOOPS_ROOT, retired: null },
    repoDir: REPO_DIR,
    flow: bundledFlowOf(loop),
  });
}
