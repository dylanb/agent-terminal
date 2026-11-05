import path from 'node:path';
import type { BundleLocation } from './bundleLocation';
import { FLOWS_CATALOG_SUBDIR } from './flowHome';
import { LOOPS_V2_SUBDIR } from './userConfig';
import { layoutRoot } from './layoutRoot';

export const EXAMPLE_SUBDIR = 'example';

export const ENGINE_GUIDE_FILE = 'engine-capabilities.md';

function bundleRoot(loc: BundleLocation): string {
  return loc.packaged ? loc.resourcesPath : loc.appPath;
}

/** The bundled flow CATALOG tree (§18.1/§18.7.1) — a directory of per-flow-home entries the selectable-catalog
 *  install seeds. The build step places it here (`exampleAssetsBuild`) and the install reads it back here
 *  (CLAUDE.md writer↔reader rule). */
export function resolveExampleFlowsDir(loc: BundleLocation): string {
  return path.join(bundleRoot(loc), EXAMPLE_SUBDIR, FLOWS_CATALOG_SUBDIR);
}

export function exampleFlowsBundleRoot(dir: string): string | null {
  return layoutRoot((appPath) => resolveExampleFlowsDir({ packaged: false, appPath }), dir);
}

/** §18.1. The global-fallback `flow` destination seeds from this same path as the catalog's `feature-dev-v3`
 *  entry, so the two destinations cannot drift into shipping divergent bytes. */
export const FEATURE_DEV_ID = 'feature-dev-v3';
export function resolveFeatureDevFlowDir(loc: BundleLocation): string {
  return path.join(resolveExampleFlowsDir(loc), FEATURE_DEV_ID);
}

/** The bundled Claude Code slash commands — a sibling of the flow and loop trees, never nested in them. */
export function resolveExampleCommandsDir(loc: BundleLocation): string {
  return path.join(bundleRoot(loc), EXAMPLE_SUBDIR, 'commands');
}

/** The bundled §27 (v2) loop-def tree — the app-bundled resolution tier for `app`-namespace flow steps
 *  (§27.15). This is the destination the build step's placement computes through (`exampleAssetsBuild.ts`
 *  is the writer) and the runtime reads (CLAUDE.md writer↔reader rule) — `example/loops-v2` is the only
 *  bundled def tree. */
export function resolveExampleLoopsV2Dir(loc: BundleLocation): string {
  return path.join(bundleRoot(loc), EXAMPLE_SUBDIR, LOOPS_V2_SUBDIR);
}

/** §18.1. */
export function resolveExampleCodexSkillsDir(loc: BundleLocation): string {
  return path.join(bundleRoot(loc), EXAMPLE_SUBDIR, 'codex-skills');
}

export function resolveEngineGuideFile(loc: BundleLocation): string {
  return path.join(bundleRoot(loc), EXAMPLE_SUBDIR, ENGINE_GUIDE_FILE);
}
