// §27.8 — `example/loops-v2/<flow>/<loop>/`.

import { existsSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { resolveLoopDefV2, type LoopDefV2, type LoopDefV2Result } from '../../src/main/loopDefV2';
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

export interface BundledFlowLoop {
  flow: string;
  loop: string;
}

/** Every bundled (flow folder, loop) pair: a loop shipped in two flows appears once per flow. */
export function bundledFlowLoops(): BundledFlowLoop[] {
  return flowFolders().flatMap((flow) =>
    readdirSync(join(BUNDLED_LOOPS_ROOT, flow), { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(BUNDLED_LOOPS_ROOT, flow, e.name, `${e.name}.yaml`)))
      .map((e) => ({ flow, loop: e.name }))
      .sort((a, b) => a.loop.localeCompare(b.loop)),
  );
}

/** The pair's def, resolved within its own flow; throws when it does not resolve. */
export function resolveBundledFlowLoop({ flow, loop }: BundledFlowLoop): { def: LoopDefV2; defDir: string } {
  const r = resolveLoopDefV2(loop, { tiers: { operator: null, appBundled: BUNDLED_LOOPS_ROOT, retired: null }, repoDir: REPO_DIR, flow });
  if (!r.ok) throw new Error(`${flow}/${loop} does not resolve: ${r.reason}`);
  return { def: r.def, defDir: r.defDir };
}

/** The consolidator recipe of every bundled def that declares one. */
export function bundledConsolidatorRecipes(): (BundledFlowLoop & { path: string })[] {
  return bundledFlowLoops().flatMap((p) => {
    const { rounds } = resolveBundledFlowLoop(p).def;
    return rounds.kind === 'engine' ? [{ ...p, path: rounds.consolidator }] : [];
  });
}

export interface BundledGoalLoop extends BundledFlowLoop {
  goal: string;
  workRecipe: string;
  /** The work recipe and every other prompt file the def names. */
  promptFiles: string[];
}

/** Every bundled def with a work goal and reviewers. */
export function bundledGoalLoopsWithReviewers(): BundledGoalLoop[] {
  return bundledFlowLoops().flatMap((p) => {
    const { def } = resolveBundledFlowLoop(p);
    if (def.work.goal === undefined || def.reviewers.length === 0) return [];
    return [{ ...p, goal: def.work.goal, workRecipe: def.work.recipe, promptFiles: [def.work.recipe, ...(def.brief === undefined ? [] : [def.brief])] }];
  });
}

/** Every Markdown file under a `charter/` folder anywhere in the bundle. */
export function bundledCharterFiles(): string[] {
  return readdirSync(BUNDLED_LOOPS_ROOT, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md') && relative(BUNDLED_LOOPS_ROOT, e.parentPath).split(sep).includes('charter'))
    .map((e) => join(e.parentPath, e.name))
    .sort();
}
