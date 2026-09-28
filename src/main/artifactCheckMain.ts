// §27.12 — the standalone entry the build emits as `artifactCheck.js`; run by the agent under
// ELECTRON_RUN_AS_NODE=1 (see artifactCheck.ts).

import { readFileSync } from 'node:fs';
import { runArtifactCheck } from './artifactCheck';

const { exitCode, output } = runArtifactCheck(process.argv.slice(2), (rel) => {
  try {
    return readFileSync(rel, 'utf8');
  } catch {
    return null;
  }
});
process.stdout.write(output);
process.exit(exitCode);
