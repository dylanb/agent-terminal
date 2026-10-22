import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveRepoKey } from './repoKey';

export interface ControllerIdentity {
  launchDirectory: string;
  repositoryRoot: string | null;
}

export function captureControllerIdentity(launchDirectory: string): ControllerIdentity {
  const directory = resolve(launchDirectory);
  const key = resolveRepoKey(directory);
  return { launchDirectory: directory, repositoryRoot: existsSync(join(key, '.git')) ? key : null };
}
