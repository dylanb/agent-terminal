// Build-aware resolution of the bundled example-flow assets (§18.1/§23.4), modeled on appIcon.ts
// resolveWindowIconPath. The location is injected as a domain value (not app.isPackaged /
// process.resourcesPath reached for here) so the packaged-vs-dev branch is unit-testable.

import path from 'node:path';

export interface BundleLocation {
  packaged: boolean;
  resourcesPath: string;
  appPath: string;
}

export function resolveExampleFlowDir(loc: BundleLocation): string {
  return loc.packaged
    ? path.join(loc.resourcesPath, 'example', 'flow')
    : path.join(loc.appPath, 'example', 'flow');
}
