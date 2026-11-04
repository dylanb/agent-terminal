import { execFile, spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { APP_COMMAND_TIMEOUT_MS, commandEnvironment, parseAppGitObjectId, runAppCommand } from './appCommand';
import { confinedRealPath, confinedRealPathResult, resolveJail } from './confinedPath';
import { errMsg, isErrno } from './errno';
import { createGitHubRepositorySource, originGitHubRepository, repositoryHost } from './githubRepository';
import { openPullRequestsForBranch, type BranchPullRequest } from './pullRequestLookup';
import type { BranchPullRequests, OpenPullRequest, ProofPublisher, ProofSuite, ProofSuites, ProofWorkingTree, SuiteResult, SuiteRun } from './testProof';
import { readE2eEnvironment, readPackageVersion, readPlaywrightReport, readVitestReport, type ReportRead } from './testProofResults';
import { isRecord } from './yamlRecord';

export const TEST_PROOF_COMMENT_MARKER = '<!-- agent-terminal:test-proof-summary -->';

const REPORT_DIR = ['.agent-terminal', 'test-proof'] as const;
const VITEST_REPORT = 'vitest.json';
const E2E_REPORT = 'report.json';
const E2E_ENVIRONMENT = 'environment.json';
const COMMENTS_PER_PAGE = 50;

type Prepared = { ok: true; dir: string } | { ok: false; reason: string };

function prepareReportDir(root: string, outputs: readonly string[]): Prepared {
  const dir = resolveJail(root, ...REPORT_DIR);
  if (dir === null) return { ok: false, reason: `the repository root ${root} cannot be resolved` };
  const confined = confinedRealPathResult(dir, dir);
  if (!confined.ok) return { ok: false, reason: `the report dir ${dir} ${confined.cause === 'escapes' ? 'leads outside the repository' : 'cannot be resolved'}` };
  try {
    mkdirSync(dir, { recursive: true });
    for (const output of outputs) {
      const earlier = confinedRealPath(dir, join(dir, output));
      if (earlier === null) return { ok: false, reason: `the earlier ${output} in ${dir} cannot be removed safely` };
      rmSync(earlier, { force: true });
    }
  } catch (e) {
    return { ok: false, reason: `the report dir ${dir} could not be prepared: ${errMsg(e)}` };
  }
  return { ok: true, dir };
}

type Exit = { ok: true; code: number } | { ok: false; reason: string };

const FORWARDED_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

function runInherited(file: string, args: readonly string[], cwd: string, environment: Record<string, string>): Promise<Exit> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd, env: commandEnvironment(environment), stdio: 'inherit' });
    let interrupted: NodeJS.Signals | null = null;
    const forward = (signal: NodeJS.Signals): void => {
      interrupted = signal;
      child.kill(signal);
    };
    for (const signal of FORWARDED_SIGNALS) process.on(signal, forward);
    const settle = (exit: Exit): void => {
      for (const signal of FORWARDED_SIGNALS) process.off(signal, forward);
      resolve(exit);
    };
    child.on('error', (e) => settle({ ok: false, reason: `${file} could not start: ${errMsg(e)}` }));
    child.on('close', (code, signal) => {
      if (interrupted !== null) settle({ ok: false, reason: `the proof was interrupted by ${interrupted} while ${file} ran` });
      else settle(code === null ? { ok: false, reason: `${file} was killed by ${signal ?? 'a signal'}` } : { ok: true, code });
    });
  });
}

interface SuiteAdapter {
  outputs: readonly string[];
  start(root: string, dir: string): Promise<Exit>;
  read(root: string, dir: string): ReportRead<SuiteResult>;
}

const SUITE_ADAPTERS: Record<ProofSuite, SuiteAdapter> = {
  vitest: {
    outputs: [VITEST_REPORT],
    start: (root, dir) =>
      runInherited('pnpm', ['test', '--reporter=default', '--reporter=json', `--outputFile.json=${join(dir, VITEST_REPORT)}`, '--retry=0', '--allowOnly=false'], root, {}),
    read(root, dir) {
      const counts = readVitestReport(dir, VITEST_REPORT);
      if (counts.kind === 'unreadable') return counts;
      const jail = resolveJail(root, 'node_modules');
      const electron = jail === null ? null : readPackageVersion(join(jail, 'electron'), 'package.json');
      if (electron === null || electron.kind === 'unreadable') {
        return { kind: 'unreadable', reason: `the installed Electron version cannot be read${electron === null ? '' : `: ${electron.reason}`}` };
      }
      return { kind: 'read', value: { ...counts.value, environment: { node: process.version, electron: electron.value } } };
    },
  },
  e2e: {
    outputs: [E2E_REPORT, E2E_ENVIRONMENT],
    start: (root) => runInherited(join(root, 'scripts', 'e2e-podman.sh'), [], root, { E2E_IO_DIR: '', E2E_REPORT_DIR: join(...REPORT_DIR) }),
    read(_root, dir) {
      const counts = readPlaywrightReport(dir, E2E_REPORT);
      if (counts.kind === 'unreadable') return counts;
      const environment = readE2eEnvironment(dir, E2E_ENVIRONMENT);
      if (environment.kind === 'unreadable') return environment;
      return { kind: 'read', value: { ...counts.value, environment: environment.value } };
    },
  },
};

export function createProofSuites(root: string): ProofSuites {
  return {
    async run(suite): Promise<SuiteRun> {
      const adapter = SUITE_ADAPTERS[suite];
      const prepared = prepareReportDir(root, adapter.outputs);
      if (!prepared.ok) return { kind: 'no-exit', reason: prepared.reason };
      const exit = await adapter.start(root, prepared.dir);
      if (!exit.ok) return { kind: 'no-exit', reason: exit.reason };
      const result = adapter.read(root, prepared.dir);
      return result.kind === 'read' ? { kind: 'ran', exitCode: exit.code, result: result.value } : { kind: 'unreadable', exitCode: exit.code, reason: result.reason };
    },
  };
}

export function createProofPublisher(root: string): ProofPublisher {
  const repositories = createGitHubRepositorySource(root);
  const api = async (args: string[]): Promise<string> => {
    const repository = await repositories.resolve();
    return runAppCommand('gh', ['api', '--hostname', repositoryHost(repository), ...args], root);
  };
  const route = async (path: string): Promise<string> => {
    const { owner, name } = await repositories.resolve();
    return `repos/${owner}/${name}/${path}`;
  };

  const earlierSummary = async (pr: number, login: string): Promise<number | null> => {
    for (let page = 1; ; page++) {
      const listed: unknown = JSON.parse(await api([`${await route(`issues/${pr}/comments`)}?per_page=${COMMENTS_PER_PAGE}&page=${page}`]));
      if (!Array.isArray(listed)) throw new Error(`the comments on PR #${pr} are not a list`);
      for (const comment of listed) {
        if (
          isRecord(comment) &&
          Number.isSafeInteger(comment.id) &&
          isRecord(comment.user) &&
          comment.user.login === login &&
          typeof comment.body === 'string' &&
          comment.body.startsWith(TEST_PROOF_COMMENT_MARKER)
        ) {
          return comment.id as number;
        }
      }
      if (listed.length < COMMENTS_PER_PAGE) return null;
    }
  };

  return {
    async status(sha, context, description) {
      await api([await route(`statuses/${sha}`), '-f', 'state=success', '-f', `context=${context}`, '-f', `description=${description}`]);
    },
    async summary(pr, body) {
      const user: unknown = JSON.parse(await api(['user']));
      if (!isRecord(user) || typeof user.login !== 'string') throw new Error('gh api user did not name the logged-in user');
      const marked = `${TEST_PROOF_COMMENT_MARKER}\n${body}`;
      const earlier = await earlierSummary(pr, user.login);
      if (earlier === null) await api([await route(`issues/${pr}/comments`), '-f', `body=${marked}`]);
      else await api(['-X', 'PATCH', await route(`issues/comments/${earlier}`), '-f', `body=${marked}`]);
    },
  };
}

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
        host = repositoryHost(await originGitHubRepository(root));
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
