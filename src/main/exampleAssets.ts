// Build-aware resolution of the bundled example-flow assets (§18.1/§23.4). Mirrors the bundled-icon
// resolver (appIcon.ts resolveWindowIconPath): a packaged build reads from process.resourcesPath, an
// unpackaged built run (e2e / `pnpm run dev`) from app.getAppPath(). The location is injected as a
// domain value so the packaged-vs-dev branch is unit-testable without reaching for Electron shapes.

import path from 'node:path';

export interface BundleLocation {
  packaged: boolean;
  resourcesPath: string;
  appPath: string;
}

export function resolveExampleFlowDir(loc: BundleLocation): string {
  throw new Error('not implemented');
}
