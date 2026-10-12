// The benchmark's whole-run test harness (#180): a temp developer environment to spawn `pnpm bench` from, and
// the stand-in agent/judge, `gh` double and sentinels it reaches. The developer environment holds the things a
// run must never touch or carry — planted credentials, rc files that would put a "real" `gh` first on PATH,
// a pre-existing audit file — so a test can prove they stay out of the run and unchanged.

import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, relative, resolve } from 'node:path';
import yaml from 'js-yaml';
import { APP_HOME_DIR_ENV } from '../../src/main/launchRoot';
import { auditFileName, auditRepoDir, auditRootDir } from '../../src/main/auditPaths';
import { FLOW_DEF_FILE, flowCatalogDir } from '../../src/main/flow';
import { isTodoTemplateFile, todoTemplatesDir } from '../../src/main/todoTemplate';
import { shellQuote } from '../../src/shared/shellQuote';
import { errMsg, isErrno } from '../../src/main/errno';
import { createStandIn, type StandIn } from './benchStandIn/harness';
import { createGhDouble, type GhDouble } from './benchGhDouble/harness';
import { installMinimalOperatorTier } from './benchMinimalFlow';
import type { StandInBehaviour } from './benchStandIn/protocol';

export const REPO_ROOT = resolve(__dirname, '..', '..');

/** Every wait sits far above any vitest test timeout, so only the one timeout a test lowers can end a run. */
export const GENEROUS_TIMEOUT_MS = 600_000;

export interface BenchTimeouts {
  stall_ms: number;
  situation_ms: number;
  polish_ms: number;
  run_ms: number;
  gh_ms: number;
}

export const PLANTED_DEVELOPER_SECRETS = {
  SSH_AUTH_SOCK: '/tmp/bench-planted-agent.sock',
  CLAUDE_CODE_OAUTH_TOKEN: 'planted-claude-oauth-token',
  GH_TOKEN: 'planted-developer-gh-token',
  AWS_SECRET_ACCESS_KEY: 'planted-aws-secret',
} as const;

export const BENCH_TEST_TOKEN = 'bench-test-token';
export const BENCH_TEST_SCRATCH_OWNER = 'bench-scratch';
export const DEVELOPER_HOSTS_TOKEN = 'developer-hosts-token';
export const STAND_IN_MODEL = 'stand-in-model';
export const STAND_IN_JUDGE_MODEL = 'stand-in-judge-model';
export const SENTINEL_EXIT_CODE = 97;

export interface BenchEnvOptions {
  behaviour?: StandInBehaviour;
  timeouts?: Partial<BenchTimeouts>;
  benchConfigRoot?: 'present' | 'absent';
  developerConfigRoot?: 'present' | 'absent';
  catalogFlows?: { id: string; dir: string }[];
  scratchOwner?: string | null;
  benchToken?: string | null;
  benchConfigDirValue?: string;
  agentExtraArgs?: string[];
}

export interface BenchArgs {
  flow: string;
  span: string;
  fixture: string;
  model?: string;
  runs?: number;
  out?: string;
  config?: string;
}

export interface BenchSpawnResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

export interface BenchEnv {
  repoRoot: string;
  root: string;
  checkout: string;
  devHome: string;
  devAppHome: string;
  devAuditDir: string;
  devConfigDir: string;
  benchConfigDir: string;
  configFile: string;
  outDir: string;
  env: Record<string, string>;
  standIn: StandIn;
  gh: GhDouble;
  sentinels: { dir: string; realGh: string; ssh: string; invoked(): string[] };
  args(a: BenchArgs): string[];
  spawn(args: string[], opts?: { timeoutMs?: number }): Promise<BenchSpawnResult>;
  bench(a: BenchArgs, opts?: { timeoutMs?: number }): Promise<BenchSpawnResult>;
  resultFiles(): string[];
  cleanup(): void;
}

const HERMETIC_GIT_DATE = '2020-01-01T00:00:00 +0000';

function hermeticGit(cwd: string, args: string[], emptyConfig: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      GIT_CONFIG_GLOBAL: emptyConfig,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Bench Developer',
      GIT_AUTHOR_EMAIL: 'developer@bench.invalid',
      GIT_COMMITTER_NAME: 'Bench Developer',
      GIT_COMMITTER_EMAIL: 'developer@bench.invalid',
      GIT_AUTHOR_DATE: HERMETIC_GIT_DATE,
      GIT_COMMITTER_DATE: HERMETIC_GIT_DATE,
    },
  }).trim();
}

function writeExecutable(file: string, body: string): void {
  writeFileSync(file, body);
  chmodSync(file, 0o755);
}

function installCatalogFlow(appHome: string, id: string, flowDir: string): void {
  const dest = join(flowCatalogDir(appHome), id);
  mkdirSync(dest, { recursive: true });
  cpSync(join(flowDir, FLOW_DEF_FILE), join(dest, FLOW_DEF_FILE));
  const templates = todoTemplatesDir(flowDir);
  if (!existsSync(templates)) return;
  mkdirSync(todoTemplatesDir(dest), { recursive: true });
  for (const name of readdirSync(templates).filter(isTodoTemplateFile)) cpSync(join(templates, name), join(todoTemplatesDir(dest), name));
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listFiles(join(dir, e.name)) : [join(dir, e.name)]));
}

/** A digest of every entry under `dir` — path, type, mode, and content or link target — so any byte change,
 *  added or removed entry, or mode change yields a different value. */
export function snapshotTree(dir: string, opts: { exclude?: string[] } = {}): string {
  const h = createHash('sha256');
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const rel = relative(dir, p);
      if (opts.exclude?.includes(rel)) continue;
      const st = lstatSync(p);
      h.update(`${rel}\0${st.mode}\0`);
      if (st.isSymbolicLink()) h.update(`link:${readlinkSync(p)}\0`);
      else if (st.isDirectory()) walk(p);
      else h.update(readFileSync(p)).update('\0');
    }
  };
  if (existsSync(dir)) walk(dir);
  else h.update('absent\0');
  return h.digest('hex');
}

/** A developer checkout's state: `git status --porcelain` plus the working tree outside `.git`. */
export function snapshotCheckout(dir: string): string {
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  return `${status}\0${snapshotTree(dir, { exclude: ['.git'] })}`;
}

export function createBenchEnv(opts: BenchEnvOptions = {}): BenchEnv {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bench-env-')));
  const emptyGitConfig = join(root, 'empty-gitconfig');
  writeFileSync(emptyGitConfig, '');

  const checkout = join(root, 'developer-checkout');
  mkdirSync(checkout);
  hermeticGit(checkout, ['init', '-q', '-b', 'main'], emptyGitConfig);
  writeFileSync(join(checkout, 'README.md'), '# developer checkout\n');
  hermeticGit(checkout, ['add', '-A'], emptyGitConfig);
  hermeticGit(checkout, ['commit', '-q', '-m', 'developer work'], emptyGitConfig);

  const sentinelDir = join(root, 'sentinels');
  const sentinelLog = join(sentinelDir, 'invoked.log');
  mkdirSync(sentinelDir);
  for (const name of ['gh', 'ssh']) {
    writeExecutable(join(sentinelDir, name), `#!/usr/bin/env bash\nprintf '%s\\n' ${shellQuote(name)}" $*" >> ${shellQuote(sentinelLog)}\nexit ${SENTINEL_EXIT_CODE}\n`);
  }

  const devHome = join(root, 'developer-home');
  mkdirSync(join(devHome, '.config', 'gh'), { recursive: true });
  const rc = `export PATH=${shellQuote(sentinelDir)}:"$PATH"\nexport GH_TOKEN=planted-rc-gh-token\n`;
  for (const name of ['.bashrc', '.bash_profile', '.profile', '.zshrc', '.zshenv']) writeFileSync(join(devHome, name), rc);
  writeFileSync(join(devHome, '.config', 'gh', 'hosts.yml'), `github.com:\n    oauth_token: ${DEVELOPER_HOSTS_TOKEN}\n    user: developer\n`);

  const devConfigDir = join(root, 'developer-claude-config');
  if (opts.developerConfigRoot !== 'absent') {
    mkdirSync(devConfigDir);
    writeFileSync(join(devConfigDir, 'settings.json'), '{}\n');
    mkdirSync(join(devHome, '.claude'));
    writeFileSync(join(devHome, '.claude.json'), '{}\n');
  }

  const devAppHome = join(root, 'developer-app-home');
  const devAuditDir = auditRepoDir(auditRootDir(devAppHome), checkout);
  mkdirSync(devAuditDir, { recursive: true });
  writeFileSync(join(devAuditDir, auditFileName('pre-existing', new Date(Date.UTC(2020, 0, 1)))), 'run: pre-existing\n');
  for (const f of opts.catalogFlows ?? []) installCatalogFlow(devAppHome, f.id, f.dir);

  const benchConfigParent = join(root, 'bench-config-parent');
  const benchConfigDir = join(benchConfigParent, 'bench-config');
  if (opts.benchConfigRoot !== 'absent') {
    mkdirSync(benchConfigDir, { recursive: true });
    installMinimalOperatorTier(benchConfigDir);
  }

  const standIn = createStandIn(root, opts.behaviour);
  const gh = createGhDouble(root);

  const timeouts: BenchTimeouts = {
    stall_ms: GENEROUS_TIMEOUT_MS,
    situation_ms: GENEROUS_TIMEOUT_MS,
    polish_ms: GENEROUS_TIMEOUT_MS,
    run_ms: GENEROUS_TIMEOUT_MS,
    gh_ms: GENEROUS_TIMEOUT_MS,
    ...opts.timeouts,
  };
  const configFile = join(root, 'bench.config.yaml');
  writeFileSync(
    configFile,
    yaml.dump({
      agent: { command: standIn.command, extra_args: opts.agentExtraArgs ?? ['--permission-mode', 'bypassPermissions'] },
      judge: { command: standIn.command, model: STAND_IN_JUDGE_MODEL },
      github: { scratch_owner: opts.scratchOwner === undefined ? BENCH_TEST_SCRATCH_OWNER : (opts.scratchOwner ?? '') },
      timeouts,
    }),
  );

  const outDir = join(root, 'out-parent', 'out');

  const env: Record<string, string> = {
    PATH: [gh.binDir, sentinelDir, process.env.PATH ?? ''].join(delimiter),
    HOME: devHome,
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TERM: 'dumb',
    SHELL: '/bin/bash',
    INIT_CWD: checkout,
    [APP_HOME_DIR_ENV]: devAppHome,
    BENCHMARK_CLAUDE_CONFIG_DIR: opts.benchConfigDirValue ?? benchConfigDir,
    npm_config_manage_package_manager_versions: 'false',
    npm_config_update_notifier: 'false',
    ...PLANTED_DEVELOPER_SECRETS,
  };
  env.COREPACK_HOME = process.env.COREPACK_HOME ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'node', 'corepack');
  env.COREPACK_ENABLE_NETWORK = '0';
  if (opts.developerConfigRoot !== 'absent') env.CLAUDE_CONFIG_DIR = devConfigDir;
  if (opts.benchToken !== null) env.BENCHMARK_GH_TOKEN = opts.benchToken ?? BENCH_TEST_TOKEN;
  if (opts.benchConfigRoot === 'absent') rmSync(benchConfigParent, { recursive: true, force: true });

  const absolute = (p: string): string => (isAbsolute(p) ? p : join(REPO_ROOT, p));
  const isPathLike = (flow: string): boolean => flow.includes('/') || flow.endsWith('.yaml');
  const args = (a: BenchArgs): string[] => [
    '--flow',
    isPathLike(a.flow) ? absolute(a.flow) : a.flow,
    '--span',
    a.span,
    '--fixture',
    absolute(a.fixture),
    '--model',
    a.model ?? STAND_IN_MODEL,
    ...(a.runs === undefined ? [] : ['--runs', String(a.runs)]),
    '--out',
    absolute(a.out ?? outDir),
    '--config',
    absolute(a.config ?? configFile),
  ];

  const groups = new Set<number>();
  const killGroup = (pid: number): void => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch (e) {
      if (!isErrno(e, 'ESRCH')) throw e;
    }
  };

  const spawnBench = (benchArgs: string[], o: { timeoutMs?: number } = {}): Promise<BenchSpawnResult> =>
    new Promise((resolveRun) => {
      const child = spawn('pnpm', ['--dir', REPO_ROOT, 'bench', '--', ...benchArgs], { cwd: checkout, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      if (child.pid !== undefined) groups.add(child.pid);
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
      const timer =
        o.timeoutMs === undefined
          ? null
          : setTimeout(() => {
              timedOut = true;
              killGroup(child.pid!);
            }, o.timeoutMs);
      const settle = (r: BenchSpawnResult): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        resolveRun(r);
      };
      child.on('error', (e) => settle({ code: null, signal: null, timedOut, stdout, stderr: `${stderr}${errMsg(e)}\n` }));
      child.on('close', (code, signal) => settle({ code, signal, timedOut, stdout, stderr }));
    });

  return {
    repoRoot: REPO_ROOT,
    root,
    checkout,
    devHome,
    devAppHome,
    devAuditDir,
    devConfigDir,
    benchConfigDir,
    configFile,
    outDir,
    env,
    standIn,
    gh,
    sentinels: {
      dir: sentinelDir,
      realGh: join(sentinelDir, 'gh'),
      ssh: join(sentinelDir, 'ssh'),
      invoked: () => (existsSync(sentinelLog) ? readFileSync(sentinelLog, 'utf8').split('\n').filter((l) => l.length > 0) : []),
    },
    args,
    spawn: spawnBench,
    bench: (a, o) => spawnBench(args(a), o),
    resultFiles: () => listFiles(outDir).sort(),
    cleanup: () => {
      for (const pid of groups) killGroup(pid);
      for (const pid of standIn.livePids()) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch (e) {
          if (!isErrno(e, 'ESRCH')) throw e;
        }
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}
