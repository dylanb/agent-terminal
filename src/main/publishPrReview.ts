import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { CommandFailure, run } from './appBootstrapCommand';
import { parseAppGitObjectId, runAppCommand } from './appCommand';
import { bootstrapProtectedArgs } from './appBootstrapGit';
import { createRealAppGateBranchCreate } from './appGatePush';
import { createRealAdoptionGitHub } from './adoptionPorts';
import { acceptableTickets, type AdoptionGitHub } from './adoptionStart';
import { confinedRealPathResult } from './confinedPath';
import { errMsg, isErrno } from './errno';
import { freshDisabledHooksDir } from './gitHardening';
import { matchesGitHubRepositoryUrl, repositoryHost, type GitHubRepositoryIdentity } from './githubRepository';
import { createMarkedComments, markedCommentBody, type MarkedComments } from './markedComment';
import type { RunPickup } from './trustedPickups';
import { isRecord } from './yamlRecord';
import { isAdoptedPickup, sameTicketRef, type AdoptedPickup, type TicketRef } from '../shared/appBootstrap';

/** GitHub's limit on one PR body or comment, in JavaScript string length. */
export const GITHUB_BODY_LIMIT = 65_536;

export type PublishOutcome = 'fix-pr' | 'patch-comment' | 'report-comment';

export interface FixPullRequest {
  number: number;
}

/** The publish's injection seam: what it reads and writes, each a domain concept. */
export interface PublishPrReviewPorts {
  github: AdoptionGitHub;
  /** The report at `file`, read inside the repository; throws with the reason it cannot be. */
  readReport(file: string): string;
  /** Whether `text` is the content of the file at `file`'s place in commit `oid`. */
  isCommittedFile(oid: string, file: string, text: string): Promise<boolean>;
  /** Whether the operator can push to `repo` (`<owner>/<name>`). */
  canPush(repo: string): Promise<boolean>;
  /** The commits on `branch` past `base`: how many, and whether any is a merge. */
  fixCommits(base: string, branch: string): Promise<{ count: number; merges: boolean }>;
  /** `git format-patch` output for `base..branch`, stating `base`; one combined commit titled `title` when
   *  `combine` is set. */
  patch(base: string, branch: string, combine: boolean, title: string): Promise<string>;
  pushFixBranch(branch: string): Promise<void>;
  /** The open same-repository PR from `head` into `base`, the only one a run may take as its own. */
  fixPullRequest(head: string, base: string): Promise<FixPullRequest | null>;
  createFixPullRequest(head: string, base: string, title: string, body: string): Promise<FixPullRequest>;
  replaceFixPullRequestBody(pr: number, body: string): Promise<void>;
  comments: MarkedComments;
}

export interface PublishPrReviewRequest {
  pickup: RunPickup | null;
  /** The gate's PR ref, which must be the adopted PR. */
  pr: number | null;
  /** The report artifact's path. */
  report: string | null;
}

/** The hidden marker that tells this run's comment from every other run's, the same after a relaunch. */
export const runCommentMarker = (fixBranch: string): string => `<!-- agent-terminal:pr-review-run:${fixBranch} -->`;

const ticketName = (t: TicketRef): string => `${t.repo}#${t.number}`;
const count = (n: number): string => n.toLocaleString('en-US');

/** A fence no run of backticks in `text` can close. */
function fenced(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}${text.endsWith('\n') ? '' : '\n'}${fence}`;
}

const pullUrl = (origin: GitHubRepositoryIdentity, number: number): string =>
  `https://${repositoryHost(origin)}/${origin.owner}/${origin.name}/pull/${number}`;

const linkContent = (origin: GitHubRepositoryIdentity, number: number): string =>
  `This review's fixes are in the draft pull request #${number}: ${pullUrl(origin, number)}\n`;

function patchContent(report: string, patch: string, pickup: AdoptedPickup, why: string): string {
  return (
    `${report.trimEnd()}\n\n---\n\n` +
    `This review's fixes could not be pushed to the pull request's branch because ${why}, so they are below as ` +
    `\`git format-patch\` output based on ${pickup.headOid}. Apply them with \`git am\`:\n\n${fenced(patch)}\n`
  );
}

/** Why `pr` is no longer the PR the run recorded, or null when it still is. */
function recordedPrMismatch(pickup: AdoptedPickup, pr: Awaited<ReturnType<AdoptionGitHub['pullRequest']>>, origin: GitHubRepositoryIdentity): string | null {
  const n = `pull request #${pickup.pr}`;
  if (pr.state === 'CLOSED') return `${n} is closed`;
  if (pr.state === 'MERGED') return `${n} is merged`;
  if (pr.state !== 'OPEN') return `${n} is not open`;
  if (pr.headRepo === null) return `GitHub reports no head repository for ${n}, as for a deleted fork; the run recorded ${pickup.headRepo}`;
  if (pr.headRepo !== pickup.headRepo) return `${n}'s head repository is now ${pr.headRepo}, not ${pickup.headRepo} as the run recorded`;
  if (pr.crossRepository !== pickup.crossRepository) {
    return pr.crossRepository ? `${n} is now from a fork in another repository, which the run did not record` : `${n} is no longer from a fork, as the run recorded`;
  }
  if (pr.headRef !== pickup.headRef) return `${n}'s head branch is now ${pr.headRef}, not ${pickup.headRef} as the run recorded`;
  const closes = acceptableTickets(pr, origin);
  const dropped = pickup.tickets.filter((t) => !closes.some((c) => sameTicketRef(c, t)));
  if (dropped.length > 0) return `${n} no longer closes ${dropped.map(ticketName).join(', ')}, which the run recorded`;
  return null;
}

function adoptedPickupOf(request: PublishPrReviewRequest): AdoptedPickup {
  const { pickup } = request;
  if (pickup === null) {
    throw new Error('publish-pr-review needs the adopted pull request this run is trusted to publish to, and the run has no trusted pickup; nothing was written');
  }
  if (!isAdoptedPickup(pickup)) {
    throw new Error(`publish-pr-review publishes an adopting run's review, and this is a ticket run on its own PR #${pickup.pr}; nothing was written — remove publish-pr-review from this gate`);
  }
  if (request.pr !== pickup.pr) throw new Error(`the gate names PR #${String(request.pr)}, not the adopted PR #${pickup.pr}; nothing was written`);
  return pickup;
}

function oversize(what: string, body: string): string | null {
  return body.length > GITHUB_BODY_LIMIT ? `the ${what} would be ${count(body.length)} characters, over GitHub's limit of ${count(GITHUB_BODY_LIMIT)}` : null;
}

/** §27.13 `publish-pr-review`: checks everything and composes every body before it writes, then writes each
 *  piece looking up what an earlier attempt of this run left first, so approving again completes without
 *  writing anything twice. Throws, having written nothing, when the publish is refused. */
export async function publishPrReview(ports: PublishPrReviewPorts, request: PublishPrReviewRequest): Promise<PublishOutcome> {
  const pickup = adoptedPickupOf(request);
  if (request.report === null) throw new Error('publish-pr-review names no report artifact of this step; nothing was written');
  const report = ports.readReport(request.report);
  if (report.trim().length === 0) throw new Error(`the report ${request.report} is empty; nothing was written`);
  if (await ports.isCommittedFile(pickup.headOid, request.report, report)) {
    throw new Error(`the report ${request.report} is the reviewed PR's own file, unchanged, so this run did not write it; nothing was written`);
  }

  const origin = await ports.github.origin();
  const mismatch = recordedPrMismatch(pickup, await ports.github.pullRequest(pickup.pr), origin);
  if (mismatch !== null) throw new Error(`${mismatch}; nothing was written`);

  const fixes = await ports.fixCommits(pickup.headOid, pickup.fixBranch);
  const pushable = fixes.count > 0 && !pickup.crossRepository && (await ports.canPush(pickup.headRepo));
  const outcome: PublishOutcome = fixes.count === 0 ? 'report-comment' : pushable ? 'fix-pr' : 'patch-comment';
  const marker = runCommentMarker(pickup.fixBranch);
  const title = `Review fixes for #${pickup.pr}`;

  let comment: string | null = null;
  if (outcome === 'report-comment') comment = report;
  if (outcome === 'patch-comment') {
    const why = pickup.crossRepository ? `it is in a fork, ${pickup.headRepo}` : `you do not have write permission on ${pickup.headRepo}`;
    comment = patchContent(report, await ports.patch(pickup.headOid, pickup.fixBranch, fixes.merges, title), pickup, why);
  }
  const refusal =
    outcome === 'fix-pr'
      ? (oversize('fix PR body', report) ?? oversize('run comment', markedCommentBody(marker, linkContent(origin, Number.MAX_SAFE_INTEGER))))
      : oversize('run comment', markedCommentBody(marker, comment ?? ''));
  if (refusal !== null) throw new Error(`${refusal}; nothing was written`);

  const login = await ports.comments.login();
  if (outcome === 'fix-pr') {
    await ports.pushFixBranch(pickup.fixBranch);
    let fixPr = await ports.fixPullRequest(pickup.fixBranch, pickup.headRef);
    if (fixPr === null) fixPr = await ports.createFixPullRequest(pickup.fixBranch, pickup.headRef, title, report);
    else await ports.replaceFixPullRequestBody(fixPr.number, report);
    comment = linkContent(origin, fixPr.number);
  }
  await ports.comments.upsert(pickup.pr, login, marker, comment ?? '');
  return outcome;
}

const PUSH_PERMISSIONS = new Set(['ADMIN', 'MAINTAIN', 'WRITE']);

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`GitHub returned ${what} that is not JSON`);
  }
}

export function createRealPublishPrReviewPorts(repoDir: string): PublishPrReviewPorts {
  const github = createRealAdoptionGitHub(repoDir);
  const protectedArgs = bootstrapProtectedArgs(freshDisabledHooksDir());
  const git = (args: string[], failure: string): Promise<string> => run('git', [...protectedArgs, ...args], repoDir, failure);
  const gh = async (args: string[], stdin?: string): Promise<string> => runAppCommand('gh', [...args, '--repo', (await github.origin()).selector], repoDir, stdin);
  const root = (): string => realpathSync(repoDir);
  const confined = (file: string): string => {
    const located = confinedRealPathResult(root(), file);
    if (located.ok) return located.path;
    if (located.cause === 'escapes') throw new Error(`the report ${file} leads outside the repository; nothing was written`);
    let missing = false;
    try {
      lstatSync(file);
    } catch (e) {
      missing = isErrno(e, 'ENOENT');
    }
    throw new Error(`the report ${file} ${missing ? 'is missing' : 'could not be read: its path cannot be resolved'}; nothing was written`);
  };
  const fixPullRequestFrom = (origin: GitHubRepositoryIdentity, entry: unknown): FixPullRequest | null => {
    if (!isRecord(entry) || !Number.isSafeInteger(entry.number) || typeof entry.url !== 'string') throw new Error('GitHub returned an unreadable pull request');
    const number = entry.number as number;
    return entry.isCrossRepository === false && matchesGitHubRepositoryUrl(entry.url, origin, 'pull', number) ? { number } : null;
  };
  return {
    github,
    readReport(file) {
      const real = confined(file);
      try {
        if (!statSync(real).isFile()) throw new Error('it is not a regular file');
        return readFileSync(real, 'utf8');
      } catch (e) {
        throw new Error(`the report ${file} could not be read: ${errMsg(e)}; nothing was written`);
      }
    },
    async isCommittedFile(oid, file, text) {
      const rel = path.relative(root(), confined(file)).split(path.sep).join('/');
      let committed: string;
      try {
        committed = await git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${oid}:${rel}`], 'the reviewed PR head could not be read');
      } catch (e) {
        if (e instanceof CommandFailure && e.exitCode === 1) return false;
        throw e;
      }
      const ours = await runAppCommand('git', [...protectedArgs, 'hash-object', '--stdin'], repoDir, text);
      return parseAppGitObjectId(committed, 'committed file') === parseAppGitObjectId(ours, 'report');
    },
    async canPush(repo) {
      const host = repositoryHost(await github.origin());
      const viewed = parseJson(await runAppCommand('gh', ['repo', 'view', `${host}/${repo}`, '--json', 'viewerPermission'], repoDir), 'a repository');
      return isRecord(viewed) && typeof viewed.viewerPermission === 'string' && PUSH_PERMISSIONS.has(viewed.viewerPermission);
    },
    async fixCommits(base, branch) {
      const range = `${base}..refs/heads/${branch}`;
      const lines = (s: string): number => s.split('\n').filter((l) => l.trim() !== '').length;
      const all = await git(['rev-list', '--end-of-options', range], `the fix branch ${branch} could not be read`);
      const merges = await git(['rev-list', '--merges', '--end-of-options', range], `the fix branch ${branch} could not be read`);
      return { count: lines(all), merges: lines(merges) > 0 };
    },
    async patch(base, branch, combine, title) {
      const failure = `the patch of ${branch} could not be made`;
      let tip = `refs/heads/${branch}`;
      if (combine) {
        const combined = await git(['commit-tree', '-p', base, '-m', title, `${tip}^{tree}`], failure);
        tip = parseAppGitObjectId(combined, 'combined commit');
      }
      try {
        return await git(['format-patch', '--stdout', `--base=${base}`, '--end-of-options', `${base}..${tip}`], failure);
      } catch (e) {
        // Output past the command buffer is at least a quarter-million characters, far over the body limit.
        if (e instanceof CommandFailure && e.exitCode === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          throw new Error(`the run comment would hold a patch over 1 MiB, over GitHub's limit of ${count(GITHUB_BODY_LIMIT)} characters; nothing was written`);
        }
        throw e;
      }
    },
    pushFixBranch: createRealAppGateBranchCreate(repoDir),
    async fixPullRequest(head, base) {
      const origin = await github.origin();
      const listed = parseJson(
        await gh(['pr', 'list', '--head', head, '--base', base, '--state', 'open', '--limit', '100', '--json', 'number,url,isCrossRepository']),
        'a pull request list',
      );
      if (!Array.isArray(listed)) throw new Error('GitHub returned an unreadable pull request list');
      const own = listed.map((entry) => fixPullRequestFrom(origin, entry)).filter((p): p is FixPullRequest => p !== null);
      if (own.length > 1) throw new Error(`GitHub has ${own.length} open pull requests from ${head} into ${base}: ${own.map((p) => `#${p.number}`).join(', ')}`);
      return own[0] ?? null;
    },
    async createFixPullRequest(head, base, title, body) {
      const origin = await github.origin();
      const url = (await gh(['pr', 'create', '--draft', '--base', base, '--head', head, '--title', title, '--body-file', '-'], body)).trim();
      const number = Number(/\/pull\/([1-9][0-9]*)$/.exec(url)?.[1]);
      if (!Number.isSafeInteger(number) || !matchesGitHubRepositoryUrl(url, origin, 'pull', number)) throw new Error('GitHub did not name the fix pull request it opened');
      return { number };
    },
    async replaceFixPullRequestBody(pr, body) {
      await gh(['pr', 'edit', String(pr), '--body-file', '-'], body);
    },
    comments: createMarkedComments(repoDir, async () => {
      const origin = await github.origin();
      return { host: repositoryHost(origin), owner: origin.owner, name: origin.name };
    }),
  };
}
