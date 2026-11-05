import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ArtifactCheckInputs } from './artifactCheck';
import { loadLoopCapabilities } from './loopCapabilities';

/** The inputs a check run from `dir` reads: files resolved against `dir`, and `dir`'s capabilities. */
export function artifactCheckInputs(dir: string): ArtifactCheckInputs {
  return {
    read: (rel) => {
      try {
        return readFileSync(path.resolve(dir, rel), 'utf8');
      } catch {
        return null;
      }
    },
    loadCapabilities: () => loadLoopCapabilities(dir),
  };
}
