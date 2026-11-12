// §27.4.

import { execFileSync } from 'node:child_process';
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, writeSync } from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from './atomicFile';
import { confinedRealPathResult, realpathBounded, resolveJail, resolveOwnedDirJail } from './confinedPath';
import { errMsg, isErrno } from './errno';
import type { AgentKind } from '../shared/agentKind';
import type { FlowStepDef } from './flow';
import { reviewerHome } from './reviewerPlacement';
import type { LoopDefV2Result } from './loopDefV2';
import { reviewRoster, type RosterEntry } from './reviewTurn';
import { CLAUDE_REVIEWER_AGENT, installedCodexReviewerProblem, installedReviewerProblem, isAppWrittenAgent, planReviewerAgents, reviewerAgentFile, type AgentsDir, type InstalledReviewer, type PlannedReviewerAgent } from './reviewerAgents';

const RUN_AGENTS_SEGMENTS = ['.claude', 'agents'] as const;
const EXCLUDE_LINE = `/${RUN_AGENTS_SEGMENTS.join('/')}/${reviewerAgentFile(CLAUDE_REVIEWER_AGENT, '*', '*')}`;

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

function charterProblem(reviewer: InstalledReviewer, shipped: string): string | null {
  let ours: Buffer;
  try {
    ours = readFileSync(reviewer.charter);
  } catch (e) {
    return `cannot read the charter ${reviewer.charter}: ${errMsg(e)}`;
  }
  try {
    if (ours.equals(readFileSync(shipped))) return null;
  } catch (e) {
    return `cannot read the app's charter ${shipped}: ${errMsg(e)}`;
  }
  return `the ${reviewer.persona} reviewer of ${reviewer.loop} resolves the charter ${reviewer.charter}, not the one the app ships: run Install examples to update your loops (an edited or overridden charter cannot run its reviewer)`;
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
    return { ok: false, problem: `cannot read ${dotGit}: ${errMsg(e)}` };
  }
  if (isDir) return { ok: true, dir: dotGit };
  try {
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf8'));
    if (m === null) return { ok: false, problem: `${dotGit} names no git folder` };
    const gitDir = path.resolve(runFolder, m[1]);
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
    return { ok: false, problem: `cannot read the git folder ${dotGit} points at: ${errMsg(e)}` };
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
    return `cannot add the reviewers to ${exclude}: ${errMsg(e)}`;
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
    out = execFileSync('git', ['-C', runFolder, 'check-ignore', '-v', '-n', '--', ...rels], { encoding: 'utf8', timeout: CHECK_IGNORE_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });
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
      if (!isErrno(e, 'ENOENT')) return `cannot read ${dir}: ${errMsg(e)}`;
      try {
        mkdirSync(dir);
      } catch (err) {
        return `cannot create ${dir}: ${errMsg(err)}`;
      }
    }
  }
  return null;
}

export function ensureRunReviewers(runFolder: string, reviewers: readonly InstalledReviewer[], bundleDir: string): EnsureRunReviewersResult {
  const result: EnsureRunReviewersResult = { wrote: [], problems: [] };
  if (reviewers.length === 0) return result;
  const agents = runAgentsDir(runFolder);
  if (agents.jail === null) return { wrote: [], problems: [`the run folder ${runFolder} cannot be resolved`] };
  let bundled: Map<string, PlannedReviewerAgent>;
  try {
    bundled = new Map(planReviewerAgents(bundleDir, CLAUDE_REVIEWER_AGENT).map((a) => [a.rel, a]));
  } catch (e) {
    return { wrote: [], problems: [`the app's bundled reviewers cannot be rendered: ${errMsg(e)}`] };
  }
  const wanted = new Map<string, PlannedReviewerAgent>();
  for (const reviewer of reviewers) {
    const rel = reviewerAgentFile(CLAUDE_REVIEWER_AGENT, reviewer.loop, reviewer.persona);
    const entry = bundled.get(rel);
    if (entry === undefined) {
      result.problems.push(`the app does not ship the reviewer ${reviewer.persona} of ${reviewer.loop}`);
      continue;
    }
    const charter = charterProblem(reviewer, entry.src);
    if (charter !== null) {
      result.problems.push(charter);
      continue;
    }
    wanted.set(rel, entry);
  }
  if (wanted.size === 0) return result;
  const excludeProblem = ensureExcluded(runFolder);
  if (excludeProblem !== null) return { wrote: [], problems: [...result.problems, excludeProblem] };
  const dirProblem = ensureRealDirs(runFolder);
  if (dirProblem !== null) return { wrote: [], problems: [...result.problems, dirProblem] };
  const pending: { rel: string; file: string; real: string; bytes: Buffer }[] = [];
  for (const [rel, entry] of wanted) {
    const file = path.join(agents.dir, rel);
    const real = confinedRealPathResult(agents.jail, file);
    if (!real.ok) {
      result.problems.push(`the sub-agent file ${file} is not inside ${agents.dir}`);
      continue;
    }
    try {
      const bytes = entry.bytes();
      const current = readOrNull(real.path);
      if (current !== null && current.equals(bytes)) continue;
      if (current !== null && !isAppWrittenAgent(current.toString('utf8'))) {
        result.problems.push(`${file} was not written by the app, so it is left as it is: move it away so the app can install its reviewer there`);
        continue;
      }
      pending.push({ rel, file, real: real.path, bytes });
    } catch (e) {
      result.problems.push(`cannot write ${file}: ${errMsg(e)}`);
    }
  }
  if (pending.length === 0) return result;
  const visible = gitWouldSee(runFolder, pending.map((p) => [...RUN_AGENTS_SEGMENTS, p.rel].join('/')));
  if (visible !== null) return { wrote: [], problems: [...result.problems, visible] };
  for (const { file, real, bytes } of pending) {
    try {
      if (!atomicWriteFileSync(real, bytes, { mode: 0o644 })) {
        result.problems.push(`cannot write ${file}: its folder is not a real folder`);
        continue;
      }
      result.wrote.push(file);
    } catch (e) {
      result.problems.push(`cannot write ${file}: ${errMsg(e)}`);
    }
  }
  return result;
}

/** A session loads sub-agents only when it starts, so a reviewer file written at or after `sessionStartedAt`
 *  (or just now) is one the running session has not loaded. */
export function runReviewerProblems(runFolder: string, reviewers: readonly InstalledReviewer[], bundleDir: string, sessionStartedAt: number | null): string[] {
  const ensured = ensureRunReviewers(runFolder, reviewers, bundleDir);
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
            .map((r) => path.join(agents.dir, reviewerAgentFile(CLAUDE_REVIEWER_AGENT, r.loop, r.persona)))
            .filter((file) => writtenAtOrAfter(file, sessionStartedAt));
  if (newer.length === 0) return [];
  return [`the reviewers ${newer.map((f) => path.basename(f, CLAUDE_REVIEWER_AGENT.extension)).join(', ')} were installed in ${agents.dir} after your agent session started, so it has not loaded them: restart it in ${runFolder}`];
}

export function reviewerInstallNotice(result: EnsureRunReviewersResult, runningAgent: AgentKind | null): string | null {
  const parts: string[] = [];
  if (result.wrote.length > 0 && runningAgent === 'claude-code') {
    parts.push('Restart your agent session in the run folder (for example claude --continue) before the first review: its reviewers were installed after the session started.');
  }
  const n = result.problems.length;
  if (n > 0) {
    const first = result.problems[0].replace(/\.$/, '');
    parts.push(
      n === 1
        ? `A reviewer could not be installed in this run folder, so its review turn will stop: ${first}.`
        : `${n} reviewer problems in this run folder, so those review turns will stop and say what to fix. The first: ${first}.`,
    );
  }
  return parts.length === 0 ? null : parts.join(' ');
}

export function flowReviewers(steps: readonly Pick<FlowStepDef, 'kind' | 'loop'>[], resolve: (loop: string) => LoopDefV2Result): RosterEntry[] {
  return steps.flatMap((step) => {
    if (step.kind !== 'loop' || step.loop === undefined) return [];
    const def = resolve(step.loop);
    return def.ok ? reviewRoster(def.def) : [];
  });
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
