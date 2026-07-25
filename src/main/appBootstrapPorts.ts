import { createRealAppBootstrapGit } from './appBootstrapGit';
import { createRealAppBootstrapGitHub } from './appBootstrapGithub';
import { createRealAppBootstrapConflicts } from './appBootstrapConflicts';
import { createGitHubRepositorySource } from './githubRepository';
import type {
  AppBootstrapConflicts,
  AppBootstrapGit,
  AppBootstrapGitFaults,
  AppBootstrapGitHub,
} from './bootstrapPorts';

export interface AppBootstrapPorts {
  git: AppBootstrapGit;
  github: AppBootstrapGitHub;
  conflicts: AppBootstrapConflicts;
}

export function createRealAppBootstrapPorts(
  repoDir: string,
  faults?: AppBootstrapGitFaults,
): AppBootstrapPorts {
  // The conflict store reads and deletes branches through this same git port, so every destructive
  // remote operation inherits its neutralized configuration and isolated remote dir (§27.10).
  const git = createRealAppBootstrapGit(repoDir, faults);
  return {
    git,
    github: createRealAppBootstrapGitHub(repoDir),
    conflicts: createRealAppBootstrapConflicts(
      repoDir,
      git,
      createGitHubRepositorySource(repoDir),
    ),
  };
}
