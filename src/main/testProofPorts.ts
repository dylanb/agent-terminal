import { execFile } from 'node:child_process';
import { APP_COMMAND_TIMEOUT_MS, commandEnvironment, parseAppGitObjectId, runAppCommand } from './appCommand';
import { errMsg, isErrno } from './errno';
import { originGitHubRepository } from './githubRepository';
import { openPullRequestsForBranch, type BranchPullRequest } from './pullRequestLookup';
import type { BranchPullRequests, OpenPullRequest, ProofWorkingTree } from './testProof';

export function createProofWorkingTree(root: string): ProofWorkingTree {
  return {
    async dirtyPaths() {
      const status = await runAppCommand('git', ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], root);
      return porcelainPaths(status);
    },
    async head() {
      return parseAppGitObjectId(await runAppCommand('git', ['rev-parse', '--verify', 'HEAD'], root), 'HEAD');
    },
    async branch() {
      const current = (await runAppCommand('git', ['branch', '--show-current'], root)).trim();
      return current === '' ? null : current;
    },
  };
}

// `git status --porcelain=v1 -z`: each entry is "XY path"; a rename or copy (X of R or C) is followed by
// one more NUL-separated entry holding the original path.
function porcelainPaths(status: string): string[] {
  const entries = status.split('\0').filter((entry) => entry !== '');
  const paths: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] ?? '';
    paths.push(entry.slice(3));
    if (entry[0] === 'R' || entry[0] === 'C') i++;
  }
  return paths;
}

export function createBranchPullRequests(root: string): BranchPullRequests {
  return {
    async openFor(branch): Promise<OpenPullRequest> {
      let host;
      try {
        host = (await originGitHubRepository(root)).selector.split('/')[0] ?? '';
      } catch (e) {
        return { kind: 'github-unavailable', reason: `could not read the GitHub repository for ${branch} from origin: ${errMsg(e)}` };
      }
      const unavailable = await githubUnavailableReason(root, host);
      if (unavailable !== null) return { kind: 'github-unavailable', reason: unavailable };
      let listed;
      try {
        listed = await openPullRequestsForBranch(root, branch);
      } catch (e) {
        return { kind: 'github-unavailable', reason: `could not list the open PRs for ${branch}: ${errMsg(e)}` };
      }
      return proofPullRequest(listed);
    },
  };
}

function proofPullRequest(listed: readonly BranchPullRequest[]): OpenPullRequest {
  const sameRepository = listed.filter((pr) => !pr.crossRepository);
  if (sameRepository.length > 1) return { kind: 'several', numbers: sameRepository.map((pr) => pr.number) };
  const [only] = sameRepository;
  if (only) return { kind: 'open', number: only.number, headSha: only.headSha };
  const [fork] = listed;
  return fork ? { kind: 'fork', number: fork.number } : { kind: 'none' };
}

function githubUnavailableReason(root: string, host: string): Promise<string | null> {
  return new Promise((resolve) => {
    const probe = ['auth', 'status', '--hostname', host, '--active'];
    execFile('gh', probe, { cwd: root, env: commandEnvironment(), timeout: APP_COMMAND_TIMEOUT_MS }, (error, _stdout, stderr) => {
      if (error === null) {
        resolve(null);
      } else if (isErrno(error, 'ENOENT')) {
        resolve('gh is not installed (no gh found on PATH).');
      } else if (typeof error.code === 'number') {
        const said = stderr.trim() || `exit ${error.code}`;
        resolve(`gh ${probe.join(' ')} failed: ${said}. If gh is not logged in to ${host}, run gh auth login --hostname ${host}.`);
      } else {
        resolve(`gh auth status did not finish: ${errMsg(error)}`);
      }
    });
  });
}
