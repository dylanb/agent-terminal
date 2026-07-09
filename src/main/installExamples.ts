// Non-destructive installer for the bundled example flow (§18.1/§23.4). Byte-compares each bundled
// file against the global flow home, classifies would-create / would-overwrite / already-identical,
// and writes per an explicit overwrite decision through the hardened atomic-file primitive
// (atomicFile.ts, CWE-59). Reports created / overwritten / skipped, or a human-readable error — a
// write the primitive refuses (symlinked container) is an error, never folded into skipped.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from './atomicFile';
import type { InstallExamplesPreview, InstallExamplesResult } from '../shared/ipc';
import { isValidInstallExamplesPreview, isValidInstallExamplesApply } from './ipcValidation';

/** Where the bundle lives and where its files install to (§18.1): `bundleDir` is the resolved
 *  example/flow dir; `targetDir` is the global flow home `<home>/.agent-terminal`. */
export interface ExampleDirs {
  bundleDir: string;
  targetDir: string;
}

export function previewInstallExamples(bundleDir: string, targetDir: string): InstallExamplesPreview {
  throw new Error('not implemented');
}

export function applyInstallExamples(
  bundleDir: string,
  targetDir: string,
  overwrite: boolean,
): InstallExamplesResult {
  throw new Error('not implemented');
}

export function handleInstallExamplesPreview(
  m: unknown,
  dirs: () => ExampleDirs,
): InstallExamplesPreview {
  throw new Error('not implemented');
}

export function handleInstallExamplesApply(m: unknown, dirs: () => ExampleDirs): InstallExamplesResult {
  throw new Error('not implemented');
}
