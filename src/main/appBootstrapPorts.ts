import { createRealAppBootstrapGit } from './appBootstrapGit';
import { createRealAppBootstrapConflicts } from './appBootstrapConflicts';
import { createRealAppBootstrapGitHub } from './appBootstrapGithub';
import { createGitHubRepositorySource } from './githubRepository';
import type { AppBootstrapPorts } from './appLoopBootstrap';

export function createRealAppBootstrapPorts(
  repoDir: string,
): AppBootstrapPorts {
  const repository = createGitHubRepositorySource(repoDir);
  const git = createRealAppBootstrapGit(repoDir, repository);
  return {
    git,
    github: createRealAppBootstrapGitHub(repoDir, repository),
    conflicts: createRealAppBootstrapConflicts(repoDir, repository),
    rollbackCreatedBranch: (branch, expectedOid) =>
      git.rollbackCreatedBranch(branch, expectedOid),
  };
}
