// Install tests read the example bundle exactly as the build lays it out, so every destination the build
// places — generated files included — is present, and nothing generated is committed to the repository.

import { afterAll, beforeAll } from 'vitest';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { placeBuildOutputs } from '../../src/main/exampleAssetsBuild';
import type { BundleLocation } from '../../src/main/bundleLocation';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** Builds the bundle from a copy of the repository's example trees, so the build's write to its dev app path
 *  lands under `scratch` and never in the checkout. Returns the bundle's app path. */
export function buildBundleIn(scratch: string): string {
  const root = path.join(scratch, 'root');
  cpSync(path.join(REPO_ROOT, 'example'), path.join(root, 'example'), { recursive: true });
  const appPath = path.join(scratch, 'bundle');
  placeBuildOutputs(root, appPath);
  return appPath;
}

/** Builds the bundle once for the calling suite; call it at module level, before any hook that reads it. */
export function useBuiltBundle(): () => BundleLocation {
  let scratch: string | undefined;
  let appPath: string | undefined;
  beforeAll(() => {
    scratch = mkdtempSync(path.join(tmpdir(), 'built-bundle-'));
    appPath = buildBundleIn(scratch);
  });
  afterAll(() => {
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
  });
  return () => {
    if (appPath === undefined) throw new Error('useBuiltBundle(): the bundle is read before its suite built it');
    return { packaged: false, appPath };
  };
}
