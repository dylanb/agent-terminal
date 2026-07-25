import { createRealAppBootstrapGit } from './appBootstrapGit';
import { createRealAppBootstrapGitHub } from './appBootstrapGithub';
import type { AppBootstrapGit, AppBootstrapGitFaults, AppBootstrapGitHub } from './bootstrapPorts';

export interface AppBootstrapPorts {
  git: AppBootstrapGit;
  github: AppBootstrapGitHub;
}

export function createRealAppBootstrapPorts(
  repoDir: string,
  faults?: AppBootstrapGitFaults,
): AppBootstrapPorts {
  return {
    git: createRealAppBootstrapGit(repoDir, faults),
    github: createRealAppBootstrapGitHub(repoDir),
  };
}
