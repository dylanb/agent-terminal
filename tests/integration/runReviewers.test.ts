import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, existsSync, renameSync, statSync, utimesSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveLoopDefV2 } from '../../src/main/loopDefV2';
import { reviewRoster, type RosterEntry } from '../../src/main/reviewTurn';
import { installedReviewerProblem, reviewerAgentName } from '../../src/main/reviewerAgents';
import { ensureReviewersRunnable, ensureRunReviewers, runAgentsDir, runReviewerProblems } from '../../src/main/runReviewers';

const BUNDLE_LOOPS = path.resolve('example', 'loops-v2');

function roster(loop: string, flow: string): RosterEntry[] {
  const r = resolveLoopDefV2(loop, { tiers: { operator: null, appBundled: BUNDLE_LOOPS, retired: null }, repoDir: BUNDLE_LOOPS, flow });
  if (!r.ok) throw new Error(r.reason);
  return reviewRoster(r.def);
}

let scratch: string;
let run: string;

beforeEach(() => {
  scratch = mkdtempSync(path.join(tmpdir(), 'run-reviewers-'));
  run = path.join(scratch, 'run');
  mkdirSync(run);
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('a run installs its Claude reviewers into the run folder', () => {
  it('locates the Claude reviewers of a run in its own .claude/agents folder', () => {
    expect(runAgentsDir(run).dir).toBe(path.join(run, '.claude', 'agents'));
  });

  it('installs every reviewer it is given into a run folder that has no .claude folder, and each then passes the preflight', () => {
    const reviewers = [...roster('green-loop', 'feature-dev-v3'), ...roster('plan-loop', 'plan-only')];

    const result = ensureRunReviewers(run, reviewers, BUNDLE_LOOPS);

    expect(result.problems).toEqual([]);
    for (const reviewer of reviewers) expect(installedReviewerProblem(runAgentsDir(run), reviewer)).toBeNull();
    const expected = reviewers.map((r) => `${reviewerAgentName(r.loop, r.persona)}.md`).sort();
    expect(readdirSync(runAgentsDir(run).dir).sort()).toEqual([...new Set(expected)]);
  });

  it('writes nothing the second time when every reviewer is already in place', () => {
    const reviewers = roster('green-loop', 'feature-dev-v3');
    ensureRunReviewers(run, reviewers, BUNDLE_LOOPS);

    expect(ensureRunReviewers(run, reviewers, BUNDLE_LOOPS)).toEqual({ wrote: [], problems: [] });
  });
});

describe('installed reviewers stay out of git', () => {
  const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' });
  const initRepo = (dir: string): void => {
    mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q');
    git(dir, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'root');
  };
  const untracked = (dir: string): string[] => git(dir, 'status', '--porcelain', '--untracked-files=all').split('\n').filter((l) => l !== '');
  const reviewers = (): RosterEntry[] => roster('green-loop', 'feature-dev-v3');

  it('hides the reviewers of a plain checkout from git, keeps the exclude file\'s other lines, and creates no .gitignore', () => {
    initRepo(run);
    const exclude = path.join(run, '.git', 'info', 'exclude');
    writeFileSync(exclude, '# the operator\'s own line\nbuild-output/\n');

    expect(ensureRunReviewers(run, reviewers(), BUNDLE_LOOPS).problems).toEqual([]);

    expect(readdirSync(runAgentsDir(run).dir).length).toBeGreaterThan(0);
    expect(untracked(run)).toEqual([]);
    expect(readFileSync(exclude, 'utf8').startsWith('# the operator\'s own line\nbuild-output/\n')).toBe(true);
    expect(existsSync(path.join(run, '.gitignore'))).toBe(false);
  });

  it('hides the reviewers of a linked worktree through the main repository\'s exclude file, once', () => {
    const main = path.join(scratch, 'main');
    initRepo(main);
    const worktree = path.join(scratch, 'wt');
    git(main, 'worktree', 'add', '-q', worktree);

    ensureRunReviewers(worktree, reviewers(), BUNDLE_LOOPS);
    const once = readFileSync(path.join(main, '.git', 'info', 'exclude'), 'utf8');
    ensureRunReviewers(worktree, reviewers(), BUNDLE_LOOPS);

    expect(untracked(worktree)).toEqual([]);
    expect(readFileSync(path.join(main, '.git', 'info', 'exclude'), 'utf8')).toBe(once);
  });

  it('refuses, naming the rule, when the repository\'s .gitignore un-ignores the reviewer files, and writes none', () => {
    initRepo(run);
    writeFileSync(path.join(run, '.gitignore'), '!.claude/agents/*.md\n');

    const result = ensureRunReviewers(run, reviewers(), BUNDLE_LOOPS);

    expect(result.wrote).toEqual([]);
    expect(result.problems.join(' ')).toContain('.gitignore:1:!.claude/agents/*.md');
    expect(existsSync(runAgentsDir(run).dir) ? readdirSync(runAgentsDir(run).dir) : []).toEqual([]);
  });

  it('installs beside the repository\'s own tracked agents, kept visible by .claude/* and !.claude/agents/', () => {
    initRepo(run);
    mkdirSync(path.join(run, '.claude', 'agents'), { recursive: true });
    writeFileSync(path.join(run, '.claude', 'agents', 'our-agent.md'), 'ours\n');
    writeFileSync(path.join(run, '.gitignore'), '.claude/*\n!.claude/agents/\n');
    git(run, 'add', '.');
    git(run, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'own agents');

    expect(ensureRunReviewers(run, reviewers(), BUNDLE_LOOPS).problems).toEqual([]);

    expect(untracked(run)).toEqual([]);
    expect(readFileSync(path.join(run, '.claude', 'agents', 'our-agent.md'), 'utf8')).toBe('ours\n');
  });

  it('installs into a run folder that is not a git repository', () => {
    expect(ensureRunReviewers(run, reviewers(), BUNDLE_LOOPS).problems).toEqual([]);
    expect(readdirSync(runAgentsDir(run).dir).length).toBeGreaterThan(0);
  });

  it('keeps the exclude file\'s last line intact when it has no trailing newline', () => {
    initRepo(run);
    const exclude = path.join(run, '.git', 'info', 'exclude');
    writeFileSync(exclude, 'build-output/');

    expect(ensureRunReviewers(run, reviewers(), BUNDLE_LOOPS).problems).toEqual([]);

    expect(readFileSync(exclude, 'utf8').split('\n')).toEqual(expect.arrayContaining(['build-output/', '/.claude/agents/*--*.md']));
    expect(untracked(run)).toEqual([]);
  });

  it('refuses a .git file pointing at a folder that is not a git folder, and writes nothing there', () => {
    const elsewhere = path.join(scratch, 'elsewhere');
    mkdirSync(elsewhere);
    writeFileSync(path.join(run, '.git'), `gitdir: ${elsewhere}\n`);

    const result = ensureRunReviewers(run, reviewers(), BUNDLE_LOOPS);

    expect(result.wrote).toEqual([]);
    expect(result.problems.join(' ')).toContain(elsewhere);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it('refuses a .git file pointing at another worktree\'s git folder, and leaves that repository\'s exclude file alone', () => {
    const main = path.join(scratch, 'main');
    initRepo(main);
    const other = path.join(scratch, 'other');
    git(main, 'worktree', 'add', '-q', other);
    const otherGitDir = readFileSync(path.join(other, '.git'), 'utf8').replace(/^gitdir:\s*/, '').trim();
    const exclude = path.join(main, '.git', 'info', 'exclude');
    const before = readFileSync(exclude, 'utf8');
    initRepo(run);
    rmSync(path.join(run, '.git'), { recursive: true, force: true });
    writeFileSync(path.join(run, '.git'), `gitdir: ${otherGitDir}\n`);

    const result = ensureRunReviewers(run, reviewers(), BUNDLE_LOOPS);

    expect(result.wrote).toEqual([]);
    expect(result.problems.join(' ')).toContain('not this run folder');
    expect(readFileSync(exclude, 'utf8')).toBe(before);
  });

  it('names git worktree repair when a worktree was moved by hand and its back-link is stale', () => {
    const main = path.join(scratch, 'main');
    initRepo(main);
    const moved = path.join(scratch, 'moved');
    git(main, 'worktree', 'add', '-q', path.join(scratch, 'wt'));
    renameSync(path.join(scratch, 'wt'), moved);

    expect(ensureRunReviewers(moved, reviewers(), BUNDLE_LOOPS).problems.join(' ')).toContain('git worktree repair');
  });

  it('hides the reviewers of a submodule checkout, whose .git file points at a git folder with no back-link', () => {
    const parent = path.join(scratch, 'parent');
    initRepo(parent);
    const lib = path.join(scratch, 'lib');
    initRepo(lib);
    git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'sub');
    const sub = path.join(parent, 'sub');

    expect(ensureRunReviewers(sub, reviewers(), BUNDLE_LOOPS).problems).toEqual([]);

    expect(untracked(sub)).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)('writes no reviewer when the exclude file cannot be written, and says why', () => {
    initRepo(run);
    const info = path.join(run, '.git', 'info');
    mkdirSync(info, { recursive: true });
    writeFileSync(path.join(info, 'exclude'), '');
    chmodSync(path.join(info, 'exclude'), 0o444);

    const result = ensureRunReviewers(run, reviewers(), BUNDLE_LOOPS);

    chmodSync(path.join(info, 'exclude'), 0o644);
    expect(result.wrote).toEqual([]);
    expect(result.problems.join(' ')).toContain(path.join(info, 'exclude'));
    expect(untracked(run)).toEqual([]);
  });

  it('refuses an exclude file that is a link, and writes nothing through it', () => {
    initRepo(run);
    const elsewhere = path.join(scratch, 'elsewhere');
    writeFileSync(elsewhere, 'untouched\n');
    const exclude = path.join(run, '.git', 'info', 'exclude');
    rmSync(exclude, { force: true });
    symlinkSync(elsewhere, exclude);

    const result = ensureRunReviewers(run, reviewers(), BUNDLE_LOOPS);

    expect(result.wrote).toEqual([]);
    expect(result.problems.join(' ')).toContain(exclude);
    expect(readFileSync(elsewhere, 'utf8')).toBe('untouched\n');
  });
});

describe('a run whose reviewers are missing, stale or newer than its agent session gets a way forward', () => {
  const reviewers = (): RosterEntry[] => roster('green-loop', 'feature-dev-v3');
  const agentFile = (r: RosterEntry): string => path.join(runAgentsDir(run).dir, `${reviewerAgentName(r.loop, r.persona)}.md`);

  it('asks for a restart when it had to install a reviewer, and passes once the session started after the files were written', () => {
    const first = runReviewerProblems(run, reviewers(), BUNDLE_LOOPS, null);
    expect(first.join(' ')).toMatch(/restart/i);

    const writtenAt = Math.max(...reviewers().map((r) => statSync(agentFile(r)).mtimeMs));
    expect(runReviewerProblems(run, reviewers(), BUNDLE_LOOPS, writtenAt + 1)).toEqual([]);
  });

  it('asks for a restart when a reviewer file is at or after the moment the agent session started', () => {
    ensureRunReviewers(run, reviewers(), BUNDLE_LOOPS);
    const [r] = reviewers();
    const later = new Date(Date.now() + 60_000);
    utimesSync(agentFile(r), later, later);
    const startedAt = statSync(agentFile(r)).mtimeMs;

    expect(runReviewerProblems(run, reviewers(), BUNDLE_LOOPS, startedAt).join(' ')).toContain(reviewerAgentName(r.loop, r.persona));
  });

  it('installs nothing for a reviewer whose resolved charter is not the one the app ships, and names Install examples', () => {
    const [r] = reviewers();
    const edited = path.join(scratch, 'edited.md');
    writeFileSync(edited, `${readFileSync(r.charter, 'utf8')}\nAn operator edit.\n`);

    const result = ensureRunReviewers(run, [{ ...r, charter: edited }], BUNDLE_LOOPS);

    expect(result.wrote).toEqual([]);
    expect(result.problems.join(' ')).toMatch(/Install examples/);
  });

  it('says the charter cannot be read, not that it was edited, when the run resolved one that is missing', () => {
    const [r] = reviewers();
    const missing = path.join(scratch, 'missing.md');

    const result = ensureRunReviewers(run, [{ ...r, charter: missing }], BUNDLE_LOOPS);

    expect(result.problems.join(' ')).toContain(`cannot read the charter ${missing}`);
    expect(result.problems.join(' ')).not.toMatch(/Install examples/);
  });

  it('reports, and writes nothing through, a .claude folder that is a link out of the run folder', () => {
    const outside = path.join(scratch, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, path.join(run, '.claude'));

    const result = ensureRunReviewers(run, reviewers(), BUNDLE_LOOPS);

    expect(result.problems.length).toBeGreaterThan(0);
    expect(readdirSync(outside)).toEqual([]);
    expect(installedReviewerProblem(runAgentsDir(run), reviewers()[0])).not.toBeNull();
  });

  it('reports a .claude/agents that is a dangling link', () => {
    mkdirSync(path.join(run, '.claude'));
    symlinkSync(path.join(scratch, 'nowhere'), path.join(run, '.claude', 'agents'));

    expect(ensureRunReviewers(run, reviewers(), BUNDLE_LOOPS).problems.length).toBeGreaterThan(0);
    expect(existsSync(path.join(scratch, 'nowhere'))).toBe(false);
  });

  it('leaves a same-named file the app did not write, and rewrites its own file whose body was edited', () => {
    const [mine, theirs] = reviewers();
    ensureRunReviewers(run, [mine], BUNDLE_LOOPS);
    const ownBytes = readFileSync(agentFile(mine), 'utf8');
    writeFileSync(agentFile(mine), `${ownBytes}\nedited\n`);
    mkdirSync(path.dirname(agentFile(theirs)), { recursive: true });
    writeFileSync(agentFile(theirs), '---\nname: hand-written\n---\nmine\n');

    const result = ensureRunReviewers(run, [mine, theirs], BUNDLE_LOOPS);

    expect(readFileSync(agentFile(mine), 'utf8')).toBe(ownBytes);
    expect(readFileSync(agentFile(theirs), 'utf8')).toBe('---\nname: hand-written\n---\nmine\n');
    expect(result.problems.join(' ')).toContain(agentFile(theirs));
  });
});

describe('each agent finds its reviewers where it loads them from', () => {
  const reviewers = (): RosterEntry[] => roster('green-loop', 'feature-dev-v3');

  it('installs Claude Code reviewers in the run folder and asks for a restart when they are newer than the session', () => {
    const problems = ensureReviewersRunnable('claude-code', run, reviewers(), { bundleDir: BUNDLE_LOOPS, codexAgentsDir: null, sessionStartedAt: () => 0 });

    expect(problems.join(' ')).toMatch(/restart/i);
    expect(readdirSync(runAgentsDir(run).dir).length).toBe(reviewers().length);
  });

  it('checks Codex reviewers in the Codex home, writes nothing in the run folder, and never asks when the session started', () => {
    const codexAgents = path.join(scratch, 'codex-agents');
    mkdirSync(codexAgents);
    const [missing] = reviewers();

    const problems = ensureReviewersRunnable('codex', run, reviewers(), {
      bundleDir: BUNDLE_LOOPS,
      codexAgentsDir: codexAgents,
      sessionStartedAt: () => {
        throw new Error('a Codex check read the session start');
      },
    });

    expect(problems.join(' ')).toContain(`${missing.loop}--${missing.persona}`.replaceAll('-', '_'));
    expect(existsSync(path.join(run, '.claude'))).toBe(false);
  });
});
