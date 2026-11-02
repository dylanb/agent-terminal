// Install tests read the example bundle exactly as the build lays it out, so every destination the build
// places — generated files included — is present, and nothing generated is committed to the repository.

import { afterAll, beforeAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { placeExampleAssets } from '../../src/main/exampleAssetsBuild';
import type { BundleLocation } from '../../src/main/bundleLocation';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** Builds the bundle once for the calling suite; call it at module level, before any hook that reads it. */
export function useBuiltBundle(): () => BundleLocation {
  let appPath: string | undefined;
  beforeAll(() => {
    appPath = mkdtempSync(path.join(tmpdir(), 'built-bundle-'));
    placeExampleAssets(REPO_ROOT, appPath);
  });
  afterAll(() => {
    if (appPath !== undefined) rmSync(appPath, { recursive: true, force: true });
  });
  return () => {
    if (appPath === undefined) throw new Error('useBuiltBundle(): the bundle is read before its suite built it');
    return { packaged: false, appPath };
  };
}
