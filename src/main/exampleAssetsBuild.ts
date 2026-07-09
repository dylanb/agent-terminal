// Build-time placement of the bundled example flow (not a runtime path). The packaged app gets
// example/flow via electron-builder extraResources (electron-builder.yml); an UNPACKAGED built run
// (e2e / `pnpm run dev`) instead reads it from <app.getAppPath()>/example/flow, and app.getAppPath()
// is the main out dir — so the build must copy the committed tree there. Reusing resolveExampleFlowDir
// as the destination keeps this copy and the runtime read from ever drifting.

import { cpSync } from 'node:fs';
import path from 'node:path';
import { resolveExampleFlowDir } from './exampleAssets';

/** Copy <rootDir>/example/flow to where the unpackaged resolver reads it when app.getAppPath() is
 *  `mainOutDir`. Returns the destination path. */
export function copyExampleFlow(rootDir: string, mainOutDir: string): string {
  throw new Error('not implemented');
}
