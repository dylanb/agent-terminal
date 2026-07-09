import path from 'node:path';
import type { BundleLocation } from './bundleLocation';

export function resolveExampleFlowDir(loc: BundleLocation): string {
  return loc.packaged
    ? path.join(loc.resourcesPath, 'example', 'flow')
    : path.join(loc.appPath, 'example', 'flow');
}
