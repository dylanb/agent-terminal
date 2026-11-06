import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { commandEnvironment } from '../../src/main/appCommand';
import { shellQuote } from '../../src/shared/shellQuote';
import { installAdoptionGh, type AdoptionGh, type NameWithOwner, type StandInPull, type StandInTicket, type ViewerPermission } from './adoptionGh';
import { TOOL_CALL_FIELD, TOOL_CALL_RECORD, readToolCalls, type ToolCall } from './outwardWrites';

const FIXED_DATE = '2020-01-01T00:00:00 +0000';

export interface AdoptionWorldOptions {
  prefix: string;
  /** Default `owner/repo`. */
  origin?: NameWithOwner;
  pr?: {
    number?: number;
    headBranch?: string;
    /** The PR's base branch; default `main`. With `stackedOn`, the PR merges into that branch instead. */
    stackedOn?: string;
    /** The fork the head lives in. Its head is then served only as `refs/pull/<n>/head`. */
    fork?: NameWithOwner;
    state?: StandInPull['state'];
    closingIssues?: StandInTicket[];
  };
  /** The operator's permission on the head repository. Default `WRITE`. */
  viewerPermission?: ViewerPermission;
}

export interface AdoptionWorld {
  /** The operator's clone: on `main`, clean, origin `originUrl`. */
  readonly repo: string;
  /** The local bare repository every fetch and push of `originUrl` reaches. */
  readonly bareRemote: string;
  /** `https://github.com/<origin>.git`, redirected to `bareRemote` through `env`'s git config. */
  readonly originUrl: string;
  readonly origin: NameWithOwner;
  readonly prNumber: number;
  readonly headBranch: string;
  readonly baseBranch: string;
  /** Where the PR head and its base branch stood when the world was built. */
  readonly startHeadOid: string;
  readonly startBaseOid: string;
  /** The environment the app, or the code under test, runs in: the logging git and the gh stand-in first on
   *  `PATH`, and a git config of its own (identity, fixed dates, the origin redirect). */
  readonly env: Record<string, string>;
  readonly gh: AdoptionGh;
  /** Applies `env` to `process.env`, for code under test that runs in this process; `dispose` restores it. */
  activate(): void;
  /** Every `git` and `gh` call made through `env`'s `PATH`, in order. */
  calls(): ToolCall[];
  /** Each call the gh stand-in refused as a contract breach, or failed on internally. The app may absorb the
   *  failed call, so `dispose` throws while this is not empty. */
  contractBreaches(): string[];
  /** Runs real git in `dir` with this world's config, unlogged; returns trimmed stdout. */
  git(dir: string, args: string[]): string;
  /** The object `ref` names on the remote, or null when it is absent. */
  remoteRef(ref: string): string | null;
  /** As another person: commits `contents` at `path` on `branch` (created at `startPoint`, default the PR head,
   *  when it does not exist yet) and pushes it to the remote. Moving the PR's head branch also moves
   *  `refs/pull/<n>/head` and the head GitHub reports. Returns the new commit. */
  pushAs(branch: string, path: string, contents: string, message: string, startPoint?: string): string;
  /** As the PR's author: rewrites the PR head's last commit and force-pushes it. Returns the new head. */
  forcePushPrHead(message: string): string;
  /** Restores `process.env`, removes every directory this world made, then throws if any contract was breached. */
  dispose(): void;
}

// Resolved before any world can put its logging wrapper first on PATH.
const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
const FIXTURE_NAME = 'Fixture Person';
const FIXTURE_EMAIL = 'person@test.invalid';

/** A hermetic GitHub for an adopted-PR run: real git against a local bare remote, and the gh stand-in from
 *  `installAdoptionGh`. The reviewed PR closes `closingIssues` (default origin's #176) and its head is one
 *  commit beyond its base branch, served as `refs/pull/<n>/head` like GitHub does for every PR. */
export function createAdoptionWorld(options: AdoptionWorldOptions): AdoptionWorld {
  const root = mkdtempSync(join(tmpdir(), `${options.prefix}-`));
  try {
    return buildWorld(root, options);
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function buildWorld(root: string, options: AdoptionWorldOptions): AdoptionWorld {
  const origin = options.origin ?? 'owner/repo';
  const prNumber = options.pr?.number ?? 41;
  const headBranch = options.pr?.headBranch ?? 'feature/reviewed-change';
  const stackedOn = options.pr?.stackedOn;
  const baseBranch = stackedOn ?? 'main';
  const fork = options.pr?.fork;
  const realGit = REAL_GIT;
  const binDir = join(root, 'bin');
  const bareRemote = join(root, 'remote.git');
  const author = join(root, 'author');
  const repo = join(root, 'repo');
  const logFile = join(root, 'calls.log');
  const globalConfig = join(root, 'gitconfig');
  const systemConfig = join(root, 'gitconfig-system');
  const originUrl = `https://github.com/${origin}.git`;
  mkdirSync(binDir);
  writeFileSync(systemConfig, '');
  const emptyFile = join(root, 'empty');
  writeFileSync(emptyFile, '');
  writeFileSync(logFile, '');

  const gitEnv = {
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_SYSTEM: systemConfig,
    GIT_AUTHOR_NAME: FIXTURE_NAME,
    GIT_AUTHOR_EMAIL: FIXTURE_EMAIL,
    GIT_AUTHOR_DATE: FIXED_DATE,
    GIT_COMMITTER_NAME: FIXTURE_NAME,
    GIT_COMMITTER_EMAIL: FIXTURE_EMAIL,
    GIT_COMMITTER_DATE: FIXED_DATE,
  };
  const git = (dir: string, args: string[]): string =>
    execFileSync(realGit, args, { cwd: dir, encoding: 'utf8', env: commandEnvironment(gitEnv), stdio: ['ignore', 'pipe', 'pipe'] }).trim();

  git(root, ['config', '--file', globalConfig, 'user.name', FIXTURE_NAME]);
  git(root, ['config', '--file', globalConfig, 'user.email', FIXTURE_EMAIL]);
  // Git reads $XDG_CONFIG_HOME/git/{ignore,attributes} even with GIT_CONFIG_GLOBAL set.
  git(root, ['config', '--file', globalConfig, 'core.excludesFile', emptyFile]);
  git(root, ['config', '--file', globalConfig, 'core.attributesFile', emptyFile]);
  git(root, ['config', '--file', globalConfig, 'init.defaultBranch', 'main']);
  git(root, ['config', '--file', globalConfig, `url.file://${bareRemote}/.insteadOf`, originUrl]);
  // Git applies the longest matching insteadOf, so origin keeps its redirect and any other GitHub URL fails locally.
  for (const github of ['https://github.com/', 'git@github.com:', 'ssh://git@github.com/']) {
    git(root, ['config', '--file', globalConfig, '--add', `url.file://${join(root, 'no-network')}/.insteadOf`, github]);
  }

  git(root, ['init', '-q', '--bare', bareRemote]);
  git(root, ['init', '-q', author]);
  const commitFile = (path: string, contents: string, message: string): string => {
    const abs = join(author, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents);
    git(author, ['add', '--', path]);
    git(author, ['commit', '-q', '-m', message]);
    return git(author, ['rev-parse', 'HEAD']);
  };
  commitFile('README.md', 'base\n', 'Base commit');
  git(author, ['push', '-q', bareRemote, 'main']);
  if (stackedOn !== undefined) {
    git(author, ['checkout', '-q', '-b', stackedOn]);
    commitFile('parent.txt', 'parent PR change\n', 'Parent PR change');
    git(author, ['push', '-q', bareRemote, stackedOn]);
  }
  git(author, ['checkout', '-q', '-b', headBranch]);
  const startHeadOid = commitFile('change.txt', 'reviewed PR change\n', 'Reviewed PR change');
  const pullRef = `refs/pull/${prNumber}/head`;
  const publishHead = (oid: string, force: boolean): void => {
    const refspecs = [`${oid}:${pullRef}`, ...(fork === undefined ? [`${oid}:refs/heads/${headBranch}`] : [])];
    git(author, ['push', '-q', ...(force ? ['--force'] : []), bareRemote, ...refspecs]);
  };
  publishHead(startHeadOid, false);
  const startBaseOid = git(author, ['rev-parse', baseBranch]);

  git(root, ['clone', '-q', bareRemote, repo]);
  git(repo, ['remote', 'set-url', 'origin', originUrl]);

  const octal = (c: string): string => `\\${c.charCodeAt(0).toString(8).padStart(3, '0')}`;
  writeFileSync(
    join(binDir, 'git'),
    `#!/usr/bin/env bash\nprintf '%s${octal(TOOL_CALL_FIELD)}' $'${octal(TOOL_CALL_RECORD)}git' "$@" >> ${shellQuote(logFile)}\nexec ${shellQuote(realGit)} "$@"\n`,
    { mode: 0o755 },
  );
  const repositories = [
    { nameWithOwner: origin, defaultBranch: 'main', viewerPermission: fork === undefined ? (options.viewerPermission ?? 'WRITE') : 'WRITE' },
    ...(fork === undefined ? [] : [{ nameWithOwner: fork, defaultBranch: 'main', viewerPermission: options.viewerPermission ?? 'WRITE' }]),
  ] satisfies { nameWithOwner: NameWithOwner; defaultBranch: string; viewerPermission: ViewerPermission }[];
  const gh = installAdoptionGh(binDir, { logFile, bareRemote, realGit }, {
    origin,
    repositories,
    pulls: [{
      number: prNumber,
      state: options.pr?.state ?? 'OPEN',
      title: 'Reviewed PR title, never intent',
      body: 'Reviewed PR body, never intent',
      isDraft: false,
      author: 'contributor',
      headRefName: headBranch,
      headRefOid: startHeadOid,
      baseRefName: baseBranch,
      headRepo: fork ?? origin,
      isCrossRepository: fork !== undefined,
      closingIssues: options.pr?.closingIssues ?? [{ repo: origin, number: 176 }],
    }],
  });

  const env = { ...gitEnv, PATH: `${binDir}:${process.env.PATH ?? ''}` };
  const saved = new Map<string, string | undefined>();
  const contractBreaches = (): string[] => gh.breaches();

  const moveReportedHead = (oid: string): void =>
    gh.update((state) => {
      const pr = state.pulls.find((p) => p.number === prNumber);
      if (pr) pr.headRefOid = oid;
    });

  return {
    repo,
    bareRemote,
    originUrl,
    origin,
    prNumber,
    headBranch,
    baseBranch,
    startHeadOid,
    startBaseOid,
    env,
    gh,
    activate() {
      for (const [key, value] of Object.entries(env)) {
        if (!saved.has(key)) saved.set(key, process.env[key]);
        process.env[key] = value;
      }
    },
    calls: () => readToolCalls(logFile),
    contractBreaches,
    git,
    remoteRef(ref) {
      try {
        return git(root, ['--git-dir', bareRemote, 'rev-parse', '--verify', '--quiet', '--end-of-options', ref]);
      } catch (e) {
        if (e instanceof Error && 'status' in e && e.status === 1) return null;
        throw e;
      }
    },
    pushAs(branch, path, contents, message, startPoint) {
      const local = git(author, ['branch', '--list', branch]);
      if (local.length > 0) git(author, ['checkout', '-q', branch]);
      else git(author, ['checkout', '-q', '-b', branch, startPoint ?? git(author, ['rev-parse', headBranch])]);
      const oid = commitFile(path, contents, message);
      if (branch === headBranch) {
        publishHead(oid, false);
        moveReportedHead(oid);
      } else {
        git(author, ['push', '-q', bareRemote, branch]);
      }
      return oid;
    },
    forcePushPrHead(message) {
      git(author, ['checkout', '-q', headBranch]);
      git(author, ['commit', '-q', '--amend', '-m', message]);
      const oid = git(author, ['rev-parse', 'HEAD']);
      publishHead(oid, true);
      moveReportedHead(oid);
      return oid;
    },
    dispose() {
      const breaches = contractBreaches();
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      saved.clear();
      rmSync(root, { recursive: true, force: true });
      if (breaches.length > 0) throw new Error(`the gh stand-in recorded contract breaches:\n${breaches.join('\n')}`);
    },
  };
}
