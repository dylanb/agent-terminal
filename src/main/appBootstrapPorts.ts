import type { BootstrapGitHub } from './bootstrapPorts';
import {
  createRealAppBootstrapGit,
  type AppBootstrapGit,
} from './appBootstrapGit';
import {
  createRealAppBootstrapConflicts,
  type AppBootstrapConflicts,
} from './appBootstrapConflicts';
import { createRealAppBootstrapGitHub } from './appBootstrapGithub';
import { resolveGitHubRepository } from './githubRepository';

export interface RealAppBootstrapPorts {
  git: AppBootstrapGit;
  github: BootstrapGitHub;
  conflicts: AppBootstrapConflicts;
  rollbackCreatedBranch(branch: string, expectedOid: string): Promise<void>;
}

export async function createRealAppBootstrapPorts(
  repoDir: string,
): Promise<RealAppBootstrapPorts> {
  let repositoryPromise: ReturnType<typeof resolveGitHubRepository> | undefined;
  const repository = () =>
    (repositoryPromise ??= resolveGitHubRepository(repoDir));
  const git = createRealAppBootstrapGit(repoDir, repository);
  return {
    git,
    github: createRealAppBootstrapGitHub(repoDir, repository),
    conflicts: createRealAppBootstrapConflicts(repoDir, repository),
    rollbackCreatedBranch: (branch, expectedOid) =>
      git.rollbackCreatedBranch(branch, expectedOid),
  };
}
