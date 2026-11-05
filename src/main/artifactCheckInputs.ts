import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ArtifactCheckInputs } from './artifactCheck';

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
    loadCapabilities: () => ({ ok: false, cause: 'absent', reason: '' }),
  };
}
