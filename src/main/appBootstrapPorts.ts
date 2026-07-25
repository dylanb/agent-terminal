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
  // §27.10 — one repository identity and one git port across all three, so a conflict this names and a
  // branch this deletes cannot resolve to different repositories.
  const repositorySource = createGitHubRepositorySource(repoDir);
  const git = createRealAppBootstrapGit(repoDir, faults, repositorySource);
  return {
    git,
    github: createRealAppBootstrapGitHub(repoDir, repositorySource),
    conflicts: createRealAppBootstrapConflicts(repoDir, git, repositorySource),
  };
}
