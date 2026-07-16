import path from 'node:path';
import type { BundleLocation } from './bundleLocation';

function bundleRoot(loc: BundleLocation): string {
  return loc.packaged ? loc.resourcesPath : loc.appPath;
}

export function resolveExampleFlowDir(loc: BundleLocation): string {
  return path.join(bundleRoot(loc), 'example', 'flow');
}

/** The bundled agent-loop definitions and everything shipped with them (§26.5). */
export function resolveExampleLoopsDir(loc: BundleLocation): string {
  return path.join(bundleRoot(loc), 'example', 'loops');
}

/** The bundled Claude Code slash commands — a sibling of the flow and loop trees, never nested in them. */
export function resolveExampleCommandsDir(loc: BundleLocation): string {
  return path.join(bundleRoot(loc), 'example', 'commands');
}
