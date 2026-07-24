import { runAppCommand } from './appCommand';
import { isRecord } from './yamlRecord';

export interface GitHubRepositoryIdentity {
  selector: string;
  owner: string;
  name: string;
  defaultBranch: string;
}

export interface ResolvedGitHubRepository
  extends GitHubRepositoryIdentity {
  fetchUrl: string;
  pushUrl: string;
}

export interface GitHubRepositorySource {
  resolve(): Promise<ResolvedGitHubRepository>;
}

export function createGitHubRepositorySource(
  repoDir: string,
): GitHubRepositorySource {
  let repository: Promise<ResolvedGitHubRepository> | undefined;
  return {
    resolve: () =>
      (repository ??= resolveGitHubRepository(repoDir)),
  };
}

const REPOSITORY_PART = /^[A-Za-z0-9_.-]+$/;
const BRANCH_NAME = /^[A-Za-z0-9._/][A-Za-z0-9._/-]*$/;

function repositoryFromRemote(
  value: string,
): Omit<GitHubRepositoryIdentity, 'defaultBranch'> | null {
  const remote = value.trim();
  let host: string;
  let repositoryPath: string;
  const scp = /^git@([^:]+):(.+)$/.exec(remote);
  if (scp) {
    host = scp[1] ?? '';
    repositoryPath = scp[2] ?? '';
  } else {
    try {
      const parsed = new URL(remote);
      if (
        (parsed.protocol !== 'https:' && parsed.protocol !== 'ssh:') ||
        parsed.password !== '' ||
        parsed.port !== '' ||
        parsed.search !== '' ||
        parsed.hash !== '' ||
        (parsed.protocol === 'https:' && parsed.username !== '') ||
        (parsed.protocol === 'ssh:' &&
          parsed.username !== '' &&
          parsed.username !== 'git')
      ) {
        return null;
      }
      host = parsed.hostname;
      repositoryPath = parsed.pathname.replace(/^\/+/, '');
    } catch {
      return null;
    }
  }
  repositoryPath = repositoryPath.replace(/\.git$/, '');
  const parts = repositoryPath.split('/');
  if (
    parts.length !== 2 ||
    !REPOSITORY_PART.test(host) ||
    !REPOSITORY_PART.test(parts[0] ?? '') ||
    !REPOSITORY_PART.test(parts[1] ?? '') ||
    [host, ...parts].some((part) => part === '.' || part === '..')
  ) {
    return null;
  }
  const owner = (parts[0] ?? '').toLowerCase();
  const name = (parts[1] ?? '').toLowerCase();
  return {
    selector: `${host.toLowerCase()}/${owner}/${name}`,
    owner,
    name,
  };
}

export function validGitHubRepositorySelector(value: string): boolean {
  const parts = value.split('/');
  return (
    parts.length === 3 &&
    parts.every(
      (part) =>
        REPOSITORY_PART.test(part) && part !== '.' && part !== '..',
    )
  );
}

export function matchesGitHubRepositoryUrl(
  value: string,
  repository: GitHubRepositoryIdentity,
  resource: 'issues' | 'pull',
  number: number,
): boolean {
  try {
    const parsed = new URL(value);
    const parts = parsed.pathname.split('/').filter(Boolean);
    return (
      parsed.protocol === 'https:' &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.port === '' &&
      parsed.search === '' &&
      parsed.hash === '' &&
      parsed.hostname.toLowerCase() === repository.selector.split('/')[0] &&
      parts.length === 4 &&
      (parts[0] ?? '').toLowerCase() === repository.owner &&
      (parts[1] ?? '').toLowerCase() === repository.name &&
      parts[2] === resource &&
      parts[3] === String(number)
    );
  } catch {
    return false;
  }
}

export async function resolveGitHubRepository(
  repoDir: string,
): Promise<ResolvedGitHubRepository> {
  const fetchUrls = (
    await runAppCommand(
      'git',
      ['remote', 'get-url', '--all', 'origin'],
      repoDir,
    )
  )
    .split('\n')
    .filter((value) => value.trim().length > 0);
  const expected = repositoryFromRemote(fetchUrls[0] ?? '');
  if (expected === null) throw new Error('invalid origin repository');
  const pushUrls = (
    await runAppCommand(
      'git',
      ['remote', 'get-url', '--push', '--all', 'origin'],
      repoDir,
    )
  )
    .split('\n')
    .filter((value) => value.trim().length > 0);
  if (
    fetchUrls.length !== 1 ||
    pushUrls.length !== 1 ||
    [...fetchUrls, ...pushUrls].some((value) => {
      const remote = repositoryFromRemote(value);
      return remote === null || remote.selector !== expected.selector;
    })
  ) {
    throw new Error('origin repository targets do not match');
  }
  const raw: unknown = JSON.parse(
    await runAppCommand(
      'gh',
      [
        'repo',
        'view',
        expected.selector,
        '--json',
        'nameWithOwner,url,defaultBranchRef',
      ],
      repoDir,
    ),
  );
  if (
    !isRecord(raw) ||
    typeof raw.nameWithOwner !== 'string' ||
    typeof raw.url !== 'string' ||
    !isRecord(raw.defaultBranchRef) ||
    typeof raw.defaultBranchRef.name !== 'string' ||
    !BRANCH_NAME.test(raw.defaultBranchRef.name)
  ) {
    throw new Error('invalid repository identity');
  }
  const viewed = repositoryFromRemote(raw.url);
  if (
    viewed === null ||
    viewed.selector !== expected.selector ||
    raw.nameWithOwner.trim().toLowerCase() !==
      `${expected.owner}/${expected.name}`
  ) {
    throw new Error('origin repository does not match GitHub');
  }
  return {
    ...expected,
    defaultBranch: raw.defaultBranchRef.name,
    fetchUrl: (fetchUrls[0] ?? '').trim(),
    pushUrl: (pushUrls[0] ?? '').trim(),
  };
}
