// §27.4.

import { execFileSync } from 'node:child_process';
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, writeSync } from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from './atomicFile';
import { confinedRealPathResult, realpathBounded, resolveJail, resolveOwnedDirJail } from './confinedPath';
import { errMsg, isErrno } from './errno';
import { coreExecHardeningArgs, freshDisabledHooksDir } from './gitHardening';
import type { AgentKind } from '../shared/agentKind';
import type { FlowStepDef } from './flow';
import { reviewerHome } from './reviewerPlacement';
import type { LoopDefV2Result } from './loopDefV2';
import { reviewRoster } from './reviewTurn';
import { CLAUDE_REVIEWER_AGENT, installedCodexReviewerProblem, installedReviewerProblem, renderReviewerAgent, type AgentsDir, type InstalledReviewer } from './reviewerAgents';

import { resolvedReviewerFile, resolvedReviewerName } from './resolvedReviewer';
import { bindsNoSurvivingEngine, DEFAULT_LOOP_NAMESPACE } from '../shared/loopNamespace';
import { RUN_REVIEWER_FILE_GLOB } from '../shared/resolvedReviewer';
import { repairAdvice } from './fileRepairAdvice';
import { readBoundedNoFollow } from './boundedRead';

const RUN_AGENTS_SEGMENTS = ['.claude', 'agents'] as const;
const EXCLUDE_LINE = `/${RUN_AGENTS_SEGMENTS.join('/')}/${RUN_REVIEWER_FILE_GLOB}`;

export interface EnsureRunReviewersResult {
  wrote: string[];
  problems: string[];
}

export function runAgentsDir(runFolder: string): AgentsDir {
  return { dir: path.join(runFolder, ...RUN_AGENTS_SEGMENTS), jail: resolveJail(runFolder, ...RUN_AGENTS_SEGMENTS) };
}

/** A file whose time cannot be read counts as newer, so the turn is refused rather than run unloaded. */
function writtenAtOrAfter(file: string, instant: number): boolean {
  try {
    return statSync(file).mtimeMs >= instant;
  } catch {
    return true;
  }
}

function isFileAt(file: string): boolean {
  try {
    return lstatSync(file).isFile();
  } catch (e) {
    if (isErrno(e, 'ENOENT')) return false;
    throw e;
  }
}

function readOrNull(file: string): Buffer | null {
  try {
    return readFileSync(file);
  } catch (e) {
    if (isErrno(e, 'ENOENT')) return null;
    throw e;
  }
}

/** The repository's common git folder, where `info/exclude` lives for every worktree of it; null for a run
 *  folder that is not a repository. Layout per gitrepository-layout(5): `.git` is that folder, or a file
 *  whose `gitdir:` names the worktree's git folder, whose `commondir` names the common one. */
function commonGitDir(runFolder: string): { ok: true; dir: string | null } | { ok: false; problem: string } {
  const dotGit = path.join(runFolder, '.git');
  let isDir: boolean;
  try {
    const st = lstatSync(dotGit);
    if (!st.isDirectory() && !st.isFile()) return { ok: false, problem: `${dotGit} is neither a folder nor a file` };
    isDir = st.isDirectory();
  } catch (e) {
    if (isErrno(e, 'ENOENT')) return { ok: true, dir: null };
    return { ok: false, problem: `cannot read ${dotGit}: ${errMsg(e)}. ${repairAdvice(e, dotGit, 'u+r', resolveJail(runFolder))}` };
  }
  if (isDir) return { ok: true, dir: dotGit };
  let gitDir: string | null = null;
  try {
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf8'));
    if (m === null) return { ok: false, problem: `${dotGit} names no git folder` };
    gitDir = path.resolve(runFolder, m[1]);
    if (!isFileAt(path.join(gitDir, 'HEAD'))) return { ok: false, problem: `${dotGit} points at ${gitDir}, which is not a git folder` };
    const backLink = readOrNull(path.join(gitDir, 'gitdir'));
    if (backLink !== null && realpathBounded(path.resolve(gitDir, backLink.toString('utf8').trim())) !== realpathSync(dotGit)) {
      return { ok: false, problem: `${dotGit} points at ${gitDir}, whose worktree is not this run folder: if this worktree was moved by hand, run git worktree repair in it` };
    }
    let common: string;
    try {
      common = path.resolve(gitDir, readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim());
    } catch (e) {
      if (!isErrno(e, 'ENOENT')) throw e;
      common = gitDir;
    }
    return { ok: true, dir: common };
  } catch (e) {
    const file = e instanceof Error && 'path' in e && typeof e.path === 'string' ? e.path : dotGit;
    const jail = file === dotGit || gitDir === null ? resolveJail(runFolder) : resolveOwnedDirJail(gitDir);
    return { ok: false, problem: `cannot inspect Git metadata ${file}: ${errMsg(e)}. ${repairAdvice(e, file, 'u+r', jail)}` };
  }
}

/** Null once git ignores every reviewer file through `info/exclude`, else why it does not. */
function ensureExcluded(runFolder: string): string | null {
  const common = commonGitDir(runFolder);
  if (!common.ok) return common.problem;
  if (common.dir === null) return null;
  const real = resolveOwnedDirJail(common.dir);
  if (real === null) return `the git folder ${common.dir} cannot be resolved`;
  const info = path.join(real, 'info');
  const exclude = path.join(info, 'exclude');
  try {
    try {
      if (!lstatSync(info).isDirectory()) return `${info} is not a real folder`;
    } catch (e) {
      if (!isErrno(e, 'ENOENT')) throw e;
      mkdirSync(info);
    }
    let text = '';
    try {
      if (!lstatSync(exclude).isFile()) return `${exclude} is not a regular file`;
      text = readFileSync(exclude, 'utf8');
    } catch (e) {
      if (!isErrno(e, 'ENOENT')) throw e;
    }
    if (text.split(/\r?\n/).includes(EXCLUDE_LINE)) return null;
    const fd = openSync(exclude, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o644);
    try {
      writeSync(fd, `${text === '' || text.endsWith('\n') ? '' : '\n'}${EXCLUDE_LINE}\n`);
    } finally {
      closeSync(fd);
    }
    return null;
  } catch (e) {
    return `cannot add the reviewers to ${exclude}: ${errMsg(e)}. ${repairAdvice(e, exclude, 'u+rw')}`;
  }
}

const CHECK_IGNORE_TIMEOUT_MS = 5000;

/** Why git would not ignore one of these run-folder paths, naming the rule that wins, or null when it ignores
 *  them all or the run folder is not a repository git can read. Output per git-check-ignore(1) `-v -n`:
 *  `<source>:<line>:<pattern>\t<path>`, empty source for no match, a `!` pattern for a negation that wins. */
function gitWouldSee(runFolder: string, rels: readonly string[]): string | null {
  if (!existsSync(path.join(runFolder, '.git'))) return null;
  let out: string;
  try {
    out = execFileSync('git', [...coreExecHardeningArgs(freshDisabledHooksDir()), '-C', runFolder, 'check-ignore', '-v', '-n', '--', ...rels], { encoding: 'utf8', timeout: CHECK_IGNORE_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const failed = e as { status?: unknown; stdout?: unknown; stderr?: unknown };
    if (failed.status === 1 && typeof failed.stdout === 'string') out = failed.stdout;
    else if (typeof failed.stderr === 'string' && failed.stderr.includes('not a git repository')) return null;
    else return `cannot ask git whether it ignores the reviewers in ${runFolder}: ${errMsg(e)}`;
  }
  for (const line of out.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const rule = line.slice(0, tab);
    const pattern = rule.split(':').slice(2).join(':');
    if (rule === '::') return `git would not ignore ${line.slice(tab + 1)}: no rule hides it, so it could be committed`;
    if (pattern.startsWith('!')) return `git would not ignore ${line.slice(tab + 1)}, because ${rule} un-ignores it: narrow that rule so it leaves .claude/agents/*--*.md ignored, then Retry`;
  }
  return null;
}

/** One level at a time, so a link or file planted at either level is reported rather than followed (CWE-59). */
function ensureRealDirs(runFolder: string): string | null {
  let dir = runFolder;
  for (const segment of RUN_AGENTS_SEGMENTS) {
    dir = path.join(dir, segment);
    try {
      if (!lstatSync(dir).isDirectory()) return `${dir} is not a real folder`;
    } catch (e) {
      if (!isErrno(e, 'ENOENT')) return `cannot read ${dir}: ${errMsg(e)}. ${repairAdvice(e, dir, 'u+rwx')}`;
      try {
        mkdirSync(dir);
      } catch (err) {
        return `cannot create ${dir}: ${errMsg(err)}. ${repairAdvice(err, dir, 'u+rwx')}`;
      }
    }
  }
  return null;
}

const MAX_REVIEWER_BYTES = 16 * 1024 * 1024;

function readCharter(file: string): string {
  const read = readBoundedNoFollow(file, MAX_REVIEWER_BYTES, true);
  if (!read.ok) throw read.error ?? new Error(`${file}: ${read.cause === 'absent' ? 'missing file' : read.cause}`);
  if (read.text.trim().length === 0) throw new Error('the charter is empty');
  return read.text;
}

export interface ReviewerCatalog {
  reviewers: readonly InstalledReviewer[];
  problems: readonly string[];
}

export function ensureRunReviewers(runFolder: string, input: readonly InstalledReviewer[] | ReviewerCatalog, _bundleDir: string): EnsureRunReviewersResult {
  const { reviewers, problems } = 'reviewers' in input ? input : { reviewers: input, problems: [] };
  const result: EnsureRunReviewersResult = { wrote: [], problems: [...problems] };
  if (reviewers.length === 0) return result;
  const agents = runAgentsDir(runFolder);
  if (agents.jail === null) return { wrote: [], problems: [`the run folder ${runFolder} cannot be resolved`] };
  const wanted = new Map<string, Buffer>();
  for (const reviewer of reviewers) {
    let charter: string;
    try {
      charter = readCharter(reviewer.charter);
    } catch (e) {
      result.problems.push(`cannot read the charter ${reviewer.charter} for reviewer ${reviewer.persona} of ${reviewer.loop}: ${errMsg(e)}. ${repairAdvice(e, reviewer.charter, 'u+r')}`);
      continue;
    }
    try {
      wanted.set(resolvedReviewerFile(reviewer), Buffer.from(renderReviewerAgent({ ...reviewer, charter }, resolvedReviewerName(reviewer))));
    } catch (e) {
      const definition = reviewer.definitionFile ?? `the definition of loop ${reviewer.loop}`;
      result.problems.push(`cannot render reviewer ${reviewer.persona} of ${reviewer.loop}: ${errMsg(e)}. Correct that reviewer's declaration in ${definition}, then Retry.`);
    }
  }
  if (result.problems.length > 0 || wanted.size === 0) return result;
  const affected = reviewers.map((reviewer) => `${reviewer.persona} of ${reviewer.loop}`).join(', ');
  const excludeProblem = ensureExcluded(runFolder);
  if (excludeProblem !== null) return { wrote: [], problems: [...result.problems, `${affected}: ${excludeProblem}. Correct the exclusion and Retry.`] };
  const dirProblem = ensureRealDirs(runFolder);
  if (dirProblem !== null) return { wrote: [], problems: [...result.problems, `${affected}: ${dirProblem}. Correct the destination and Retry.`] };
  const pending: { rel: string; file: string; bytes: Buffer }[] = [];
  for (const [rel, bytes] of wanted) {
    const file = path.join(agents.dir, rel);
    const real = confinedRealPathResult(agents.jail, file);
    if (!real.ok) {
      result.problems.push(real.cause === 'escapes'
        ? `${affected}: the sub-agent file ${file} is not inside ${agents.dir}. Correct the destination reference or link, then Retry.`
        : `${affected}: cannot resolve ${file}: ${errMsg(real.error)}. ${repairAdvice(real.error, file, 'u+rw', agents.jail)}`);
      continue;
    }
    try {
      const st = lstatSync(real.path);
      if (!st.isFile()) {
        result.problems.push(`${affected}: ${file} is not a regular file. Replace it with a regular reviewer file or remove the obstruction, then Retry.`);
        continue;
      }
      const read = readBoundedNoFollow(real.path, MAX_REVIEWER_BYTES * 2);
      if (read.ok && Buffer.from(read.text).equals(bytes)) continue;
    } catch (e) {
      if (!isErrno(e, 'ENOENT')) {
        result.problems.push(`${affected}: cannot inspect ${file}: ${errMsg(e)}. ${repairAdvice(e, file, 'u+rw')}`);
        continue;
      }
    }
    pending.push({ rel, file, bytes });
  }
  if (result.problems.length > 0 || pending.length === 0) return result;
  const visible = gitWouldSee(runFolder, pending.map((p) => [...RUN_AGENTS_SEGMENTS, p.rel].join('/')));
  if (visible !== null) return { wrote: [], problems: [...result.problems, `${affected}: ${visible}`] };
  for (const { file, bytes } of pending) {
    try {
      if (!atomicWriteFileSync(file, bytes, { mode: 0o644 })) {
        result.problems.push(`cannot write ${file}: its folder is not a real folder`);
        continue;
      }
      result.wrote.push(file);
    } catch (e) {
      result.problems.push(`${affected}: cannot write ${file}: ${errMsg(e)}. ${repairAdvice(e, path.dirname(file), 'u+rwx')}`);
    }
  }
  return result;
}

/** A session loads sub-agents only when it starts, so a reviewer file written at or after `sessionStartedAt`
 *  (or just now) is one the running session has not loaded. */
export function runReviewerProblems(runFolder: string, reviewers: readonly InstalledReviewer[], bundleDir: string, sessionStartedAt: number | null): string[] {
  const ensured = ensureRunReviewers(runFolder, reviewers, bundleDir);
  if (ensured.problems.length > 0) return ensured.problems;
  const agents = runAgentsDir(runFolder);
  const unrunnable = reviewers.map((r) => installedReviewerProblem(agents, r)).filter((p): p is string => p !== null);
  const problems = [...ensured.problems, ...unrunnable];
  if (problems.length > 0) return problems;
  const newer =
    ensured.wrote.length > 0
      ? ensured.wrote
      : sessionStartedAt === null
        ? []
        : reviewers
            .map((r) => path.join(agents.dir, resolvedReviewerFile(r)))
            .filter((file) => writtenAtOrAfter(file, sessionStartedAt));
  if (newer.length === 0) return [];
  return [`the reviewers ${newer.map((f) => path.basename(f, CLAUDE_REVIEWER_AGENT.extension)).join(', ')} were installed in ${agents.dir} after your agent session started, so it has not loaded them: restart it in ${runFolder}`];
}

export function reviewerInstallNotice(result: EnsureRunReviewersResult, runningAgent: AgentKind | null): string | null {
  const parts: string[] = [];
  if (result.wrote.length > 0 && runningAgent === 'claude-code') {
    parts.push('Restart your agent session in the run folder (for example claude --continue) before the first review: its reviewers were installed after the session started.');
  }
  if (result.problems.length > 0) {
    parts.push(`Reviewer installation failed; the flow must stay stopped until repaired:\n${result.problems.join('\n')}`);
  }
  return parts.length === 0 ? null : parts.join(' ');
}

export function flowReviewers(steps: readonly Pick<FlowStepDef, 'kind' | 'loop' | 'loopNamespace'>[], resolve: (loop: string) => LoopDefV2Result): ReviewerCatalog {
  const problems: string[] = [];
  const reviewers = steps.flatMap((step) => {
    if (step.kind !== 'loop' || step.loop === undefined || bindsNoSurvivingEngine(step.loopNamespace ?? DEFAULT_LOOP_NAMESPACE)) return [];
    const def = resolve(step.loop);
    if (!def.ok) {
      problems.push(`Cannot resolve reviewers for ${step.loop}: ${def.reason}. Correct the reported problem and Retry.`);
    }
    const catalog = def.ok ? def.def : def.reviewerDiagnostics;
    const definitionFile = def.ok ? def.definitionFile : def.reviewerDiagnostics?.definitionFile;
    return catalog === undefined ? [] : reviewRoster(catalog).map((reviewer) => ({ ...reviewer, ...(definitionFile === undefined ? {} : { definitionFile }) }));
  });
  return { reviewers, problems };
}

export interface ReviewerCheckDeps {
  bundleDir: string;
  codexAgentsDir: string | null;
  sessionStartedAt: () => number | null;
}

export function ensureReviewersRunnable(kind: AgentKind, runFolder: string, reviewers: readonly InstalledReviewer[], deps: ReviewerCheckDeps): string[] {
  switch (reviewerHome(kind)) {
    case 'run-folder':
      return runReviewerProblems(runFolder, reviewers, deps.bundleDir, deps.sessionStartedAt());
    case 'codex-home':
      return reviewers.map((r) => installedCodexReviewerProblem(deps.codexAgentsDir, r)).filter((p): p is string => p !== null);
  }
}
