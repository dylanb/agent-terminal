import { runAppCommand } from './appCommand';
import { run } from './appBootstrapCommand';
import { isRecord } from './yamlRecord';
import { isPickupBranchName, isRepositoryPart } from '../shared/appBootstrap';
import {
  createOriginConfigReader,
  originUrls,
  type OriginConfigReader,
} from './originUrl';

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
    resolve: () => {
      if (repository !== undefined) return repository;
      const attempt = resolveGitHubRepository(repoDir);
      repository = attempt;
      attempt.catch(() => {
        if (repository === attempt) repository = undefined;
      });
      return attempt;
    },
  };
}


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
    ![host, ...parts].every((part) => isRepositoryPart(part ?? ''))
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

export function repositoryHost(repository: Pick<GitHubRepositoryIdentity, 'selector'>): string {
  return repository.selector.split('/')[0] ?? '';
}

export function validGitHubRepositorySelector(value: string): boolean {
  const parts = value.split('/');
  return (
    parts.length === 3 &&
    parts.every(isRepositoryPart)
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
      parsed.hostname.toLowerCase() === repositoryHost(repository) &&
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

function originConfigReader(repoDir: string): OriginConfigReader {
  return createOriginConfigReader((args) =>
    run('git', args, repoDir, 'origin resolution failed'),
  );
}

export async function originGitHubRepository(
  repoDir: string,
): Promise<Omit<ResolvedGitHubRepository, 'defaultBranch'>> {
  const reader = originConfigReader(repoDir);
  const fetchUrls = await originUrls(reader, 'fetch');
  const expected = repositoryFromRemote(fetchUrls[0] ?? '');
  if (expected === null) throw new Error('invalid origin repository');
  const pushUrls = await originUrls(reader, 'push');
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
  return { ...expected, fetchUrl: (fetchUrls[0] ?? '').trim(), pushUrl: (pushUrls[0] ?? '').trim() };
}

/** Origin's repository as its fetch URL names it: the one a read reaches, whatever origin pushes to. */
export async function originFetchGitHubRepository(
  repoDir: string,
): Promise<Omit<GitHubRepositoryIdentity, 'defaultBranch'>> {
  const fetchUrls = await originUrls(originConfigReader(repoDir), 'fetch');
  const repository = fetchUrls.length === 1 ? repositoryFromRemote(fetchUrls[0] ?? '') : null;
  if (repository === null) throw new Error('invalid origin repository');
  return repository;
}

/** The GitHub repository origin pushes to when it is not the one origin fetches from (a fork), else null. */
export async function originPushForkRepository(
  repoDir: string,
): Promise<Omit<GitHubRepositoryIdentity, 'defaultBranch'> | null> {
  const reader = originConfigReader(repoDir);
  const [fetchUrls, pushUrls] = [await originUrls(reader, 'fetch'), await originUrls(reader, 'push')];
  const fetched = fetchUrls.length === 1 ? repositoryFromRemote(fetchUrls[0] ?? '') : null;
  const pushed = pushUrls.length === 1 ? repositoryFromRemote(pushUrls[0] ?? '') : null;
  return pushed !== null && fetched !== null && pushed.selector !== fetched.selector ? pushed : null;
}

export async function resolveGitHubRepository(
  repoDir: string,
): Promise<ResolvedGitHubRepository> {
  const expected = await originGitHubRepository(repoDir);
  const viewedRepository = await runAppCommand(
    'gh',
    [
      'repo',
      'view',
      expected.selector,
      '--json',
      'nameWithOwner,url,defaultBranchRef',
    ],
    repoDir,
  );
  let raw: unknown;
  try {
    raw = JSON.parse(viewedRepository);
  } catch {
    throw new Error('invalid repository identity');
  }
  if (
    !isRecord(raw) ||
    typeof raw.nameWithOwner !== 'string' ||
    typeof raw.url !== 'string' ||
    !isRecord(raw.defaultBranchRef) ||
    typeof raw.defaultBranchRef.name !== 'string' ||
    !isPickupBranchName(raw.defaultBranchRef.name)
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
  };
}
