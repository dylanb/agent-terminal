import { realpathSync } from 'node:fs';
import { run, CommandFailure } from './appBootstrapCommand';
import { createAppGitRemote, parseAppGitObjectId, runAppCommand } from './appCommand';
import { bootstrapProtectedArgs, isApprovedGitRemote } from './appBootstrapGit';
import { freshDisabledHooksDir } from './gitHardening';
import { treeIsClean } from './gitTreeState';
import { createOriginConfigReader, soleOriginUrl } from './originUrl';
import { createGitHubRepositorySource } from './githubRepository';
import { isRecord } from './yamlRecord';
import { namesAppLoopSegment } from './appLoopPaths';
import type { AdoptionGit, AdoptionGitHub, AdoptionPullRequest } from './adoptionStart';

const PR_FIELDS = 'state,headRefName,baseRefName,headRepository,headRepositoryOwner,isCrossRepository,closingIssuesReferences';

/** `<owner>/<name>` of a PR's head repository, lowercased, from GitHub's `headRepository` and
 *  `headRepositoryOwner`; null when GitHub reports none (a deleted fork). */
export function headRepositoryName(headRepository: unknown, headRepositoryOwner: unknown): string | null {
  const name = isRecord(headRepository) && typeof headRepository.name === 'string' ? headRepository.name : null;
  const owner = isRecord(headRepositoryOwner) && typeof headRepositoryOwner.login === 'string' ? headRepositoryOwner.login : null;
  return name === null || owner === null ? null : `${owner}/${name}`.toLowerCase();
}

/** GitHub's answer for a PR, or a thrown reason when it is not the shape the adoption reads. */
export function parseAdoptionPullRequest(raw: string): AdoptionPullRequest {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    throw new Error('GitHub returned a pull request that is not JSON');
  }
  if (!isRecord(doc)) throw new Error('GitHub returned a pull request that is not an object');
  const { state, headRefName, baseRefName, headRepository, headRepositoryOwner, isCrossRepository, closingIssuesReferences } = doc;
  if (typeof state !== 'string' || typeof headRefName !== 'string' || typeof baseRefName !== 'string' || typeof isCrossRepository !== 'boolean') {
    throw new Error('GitHub returned a pull request without its state, branches and fork flag');
  }
  if (!Array.isArray(closingIssuesReferences)) throw new Error('GitHub returned a pull request without its closing tickets');
  const closingIssues = closingIssuesReferences.flatMap((issue: unknown) =>
    isRecord(issue) && typeof issue.url === 'string' && typeof issue.number === 'number' ? [{ url: issue.url, number: issue.number }] : [],
  );
  return {
    state,
    headRef: headRefName,
    baseRef: baseRefName,
    headRepo: headRepositoryName(headRepository, headRepositoryOwner),
    crossRepository: isCrossRepository,
    closingIssues,
  };
}

export function createRealAdoptionGitHub(repoDir: string): AdoptionGitHub {
  const repository = createGitHubRepositorySource(repoDir);
  return {
    origin: () => repository.resolve(),
    pullRequest: async (pr) => {
      const { selector } = await repository.resolve();
      return parseAdoptionPullRequest(await runAppCommand('gh', ['pr', 'view', String(pr), '--repo', selector, '--json', PR_FIELDS], repoDir));
    },
  };
}

type Checkout = { kind: 'branch'; value: string } | { kind: 'detached'; value: string };

export function createRealAdoptionGit(repoDir: string): AdoptionGit {
  const protectedArgs = bootstrapProtectedArgs(freshDisabledHooksDir());
  const git = (args: string[], failure: string): Promise<string> => run('git', [...protectedArgs, ...args], repoDir, failure);
  const remote = createAppGitRemote(repoDir, protectedArgs);
  const originConfig = createOriginConfigReader((args) => git(args, 'origin resolution failed'));
  const expectedRepoRoot = realpathSync(repoDir);
  let restore: Checkout | null = null;
  const originFetchUrl = async (): Promise<string> => {
    const url = await soleOriginUrl(originConfig, 'fetch');
    if (url === null || !isApprovedGitRemote(url)) throw new Error('unsafe origin transport configuration');
    return url;
  };
  const fetchCommit = async (ref: string, failure: string): Promise<string> => {
    const url = await originFetchUrl();
    let fetched: string;
    try {
      fetched = await remote.fetchRef(url, ref);
    } catch (e) {
      throw new CommandFailure(failure, e instanceof CommandFailure ? e.exitCode : undefined);
    }
    return parseAppGitObjectId(await git(['rev-parse', '--verify', `${fetched}^{commit}`], `${failure}: not a commit`), 'fetched commit');
  };
  const currentCheckout = async (): Promise<Checkout> => {
    try {
      const branch = (await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], 'current branch resolution failed')).trim();
      if (branch.length > 0) return { kind: 'branch', value: branch };
    } catch (e) {
      if (!(e instanceof CommandFailure && e.exitCode === 1)) throw e;
    }
    return { kind: 'detached', value: (await git(['rev-parse', 'HEAD'], 'current commit resolution failed')).trim() };
  };
  const localOid = async (branch: string): Promise<string | null> => {
    try {
      await git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], 'local branch probe failed');
    } catch (e) {
      if (e instanceof CommandFailure && e.exitCode === 1) return null;
      throw e;
    }
    return (await git(['rev-parse', '--verify', `refs/heads/${branch}`], 'local branch probe failed')).trim();
  };
  // One level of a tree, so a large repository's whole listing is never read.
  const treeEntries = async (treeish: string): Promise<Array<{ type: string; oid: string; name: string }>> =>
    (await git(['ls-tree', '-z', `${treeish}^{tree}`], 'pull request tree read failed'))
      .split('\0')
      .filter((entry) => entry.length > 0)
      .map((entry) => {
        const tab = entry.indexOf('\t');
        const [, type = '', oid = ''] = entry.slice(0, tab).split(' ');
        return { type, oid, name: entry.slice(tab + 1) };
      });
  return {
    isCleanTree: async () => {
      const topLevel = (await git(['rev-parse', '--show-toplevel'], 'repository identity resolution failed')).trim();
      if (realpathSync(topLevel) !== expectedRepoRoot) throw new Error('repository identity mismatch');
      if (!treeIsClean(await git(['status', '--porcelain'], 'working tree check failed'))) return false;
      try {
        await git(['diff', '--cached', '--quiet', '--'], 'staged change check failed');
        return true;
      } catch {
        return false;
      }
    },
    fetchPullRequestHead: (pr) => fetchCommit(`refs/pull/${pr}/head`, `could not fetch pull request #${pr}'s head from origin`),
    fetchBranch: async (branch) => {
      await git(['check-ref-format', '--branch', branch], 'branch name validation failed');
      return fetchCommit(`refs/heads/${branch}`, `could not fetch branch ${branch} from origin`);
    },
    mergeBase: async (a, b) => parseAppGitObjectId(await git(['merge-base', a, b], 'merge-base resolution failed'), 'merge-base'),
    trackedRunStatePaths: async (oid) => {
      const planted: string[] = [];
      for (const top of (await treeEntries(oid)).filter((e) => namesAppLoopSegment(e.name, 0))) {
        if (top.type !== 'tree') {
          planted.push(top.name);
          continue;
        }
        for (const loop of (await treeEntries(top.oid)).filter((e) => namesAppLoopSegment(e.name, 1))) planted.push(`${top.name}/${loop.name}`);
      }
      return planted;
    },
    branchExists: async (branch) => (await localOid(branch)) !== null,
    createAndCheckOut: async (branch, oid) => {
      await git(['check-ref-format', '--branch', branch], 'branch name validation failed');
      restore = await currentCheckout();
      await git(['update-ref', `refs/heads/${branch}`, oid, '0'.repeat(oid.length)], 'fix branch creation failed');
      // A PR's files never replace the app's own git-ignored state: git refuses the switch instead.
      await git(
        ['switch', '--no-overwrite-ignore', '--', branch],
        `could not check out fix branch ${branch}. Git refuses this when the pull request tracks a file this working tree holds as an ignored file, which a run never overwrites, and a run cannot adopt that pull request while the file is here; any other cause may pass, so starting the step again retries it`,
      );
    },
    rollback: async (branch, oid) => {
      const checkout = await currentCheckout();
      if (restore !== null && checkout.kind === 'branch' && checkout.value === branch) {
        if (restore.kind === 'branch') await git(['switch', '--', restore.value], 'previous branch restoration failed');
        else await git(['checkout', '--detach', restore.value], 'previous commit restoration failed');
      }
      if ((await localOid(branch)) === oid) await git(['update-ref', '-d', `refs/heads/${branch}`, oid], 'fix branch removal failed');
      restore = null;
    },
  };
}
