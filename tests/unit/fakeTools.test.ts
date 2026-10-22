import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  goalAgentOverruns,
  readFakeGhIssue,
  seedFakeAgentSteps,
  seedFakeGhGit,
  seedFakeGhIssue,
  seedFakeGhLabels,
  seedGoalSessionAgent,
  seedV3GoalAgent,
  v3ImplGoals,
  writePromptedArtifact,
  type FakeGhIssue,
} from '../e2e/fakeTools';
import { reportNeedsAHuman, roundReportWellFormed } from '../../src/shared/roundReport';
import { TURN_DONE_FILENAME } from '../../src/shared/loopTurn';
import { ticketPromptLines } from '../../src/shared/currentTicket';
import { examplePhaseResult } from '../../src/shared/phaseResult';
import { verdictOutput } from '../helpers/consolidatorOutputs';

const dirs: string[] = [];
const procs: ChildProcessWithoutNullStreams[] = [];
const tmp = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const p of procs.splice(0)) p.kill('SIGKILL');
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const readIf = (p: string): string => (existsSync(p) ? readFileSync(p, 'utf8') : '');

describe('fake gh/git shims', () => {
  const shims = () => {
    const { binDir, logFile } = seedFakeGhGit('fake-tools-shim-');
    dirs.push(binDir);
    return { binDir, logFile, env: { ...process.env, FAKE_GHGIT_LOG: logFile } };
  };
  const run = (bin: string, args: string[], env: NodeJS.ProcessEnv) =>
    spawnSync(bin, args, { env, input: 'body\n', encoding: 'utf8' });
  const start = (bin: string, args: string[], env: NodeJS.ProcessEnv) => {
    const p = spawn(bin, args, { env });
    procs.push(p);
    p.stdin.end('body\n');
    const exited = new Promise<number | null>((r) => p.on('exit', (code) => r(code)));
    return { p, exited };
  };

  it('git rev-parse --abbrev-ref HEAD answers like real git: the ref\'s branch, HEAD when detached, main when HEAD is absent', () => {
    const { binDir, env } = shims();
    const repo = tmp('fake-tools-head-');
    const branch = () => spawnSync(join(binDir, 'git'), ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo, env, encoding: 'utf8' }).stdout.trim();
    expect(branch()).toBe('main');
    mkdirSync(join(repo, '.git'));
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/plan-loop/issue-7\n');
    expect(branch()).toBe('plan-loop/issue-7');
    writeFileSync(join(repo, '.git', 'HEAD'), '0123456789abcdef0123456789abcdef01234567\n');
    expect(branch()).toBe('HEAD');
  });

  it('FAKE_GH_FAIL_ACTION fails only the named side-effect action', () => {
    const { binDir, env } = shims();
    const failing = { ...env, FAKE_GH_FAIL_ACTION: 'update-issue-body' };
    expect(run(join(binDir, 'gh'), ['issue', 'edit', '7', '--body-file', '-', '--repo', 'fake/repo'], failing).status).toBe(1);
    expect(run(join(binDir, 'gh'), ['pr', 'ready', '7', '--repo', 'fake/repo'], failing).status).toBe(0);
    expect(run(join(binDir, 'gh'), ['pr', 'edit', '7', '--body-file', '-', '--repo', 'fake/repo'], failing).status).toBe(0);
    expect(run(join(binDir, 'gh'), ['issue', 'edit', '7', '--body-file', '-', '--repo', 'fake/repo'], env).status).toBe(0);
  });

  it('FAKE_GH_HOLD holds only the named action while the file exists, logging held then released', async () => {
    const { binDir, logFile, env } = shims();
    const hold = join(binDir, 'gh-hold');
    writeFileSync(hold, '');
    const held = { ...env, FAKE_GH_HOLD: hold, FAKE_GH_HOLD_ACTION: 'update-issue-body' };
    const call = start(join(binDir, 'gh'), ['issue', 'edit', '7', '--body-file', '-', '--repo', 'fake/repo'], held);
    await vi.waitFor(() => expect(readIf(logFile)).toMatch(new RegExp(`^held ${call.p.pid} gh issue edit 7`, 'm')), { timeout: 5000 });
    expect(run(join(binDir, 'gh'), ['pr', 'ready', '7', '--repo', 'fake/repo'], held).status).toBe(0);
    expect(call.p.exitCode).toBeNull();
    rmSync(hold);
    expect(await call.exited).toBe(0);
    expect(readIf(logFile)).toMatch(new RegExp(`^released ${call.p.pid}$`, 'm'));
  });

  it('FAKE_GIT_HOLD_REV holds every git call with an argv element containing the rev, and no other', async () => {
    const { binDir, logFile, env } = shims();
    const hold = join(binDir, 'git-hold');
    writeFileSync(hold, '');
    const sha = 'abc123def456';
    const held = { ...env, FAKE_GIT_HOLD_REV: sha, FAKE_GIT_HOLD: hold };
    const call = start(join(binDir, 'git'), ['--no-replace-objects', 'cat-file', '-p', `${sha}:loop-capabilities.yaml`], held);
    await vi.waitFor(() => expect(readIf(logFile)).toMatch(new RegExp(`^held ${call.p.pid} git .*${sha}:loop-capabilities\\.yaml`, 'm')), { timeout: 5000 });
    const midElement = start(join(binDir, 'git'), ['diff', `HEAD..${sha}`], held);
    await vi.waitFor(() => expect(readIf(logFile)).toMatch(new RegExp(`^held ${midElement.p.pid} git diff HEAD\\.\\.${sha}`, 'm')), { timeout: 5000 });
    expect(run(join(binDir, 'git'), ['rev-parse', 'HEAD'], held).status).toBe(0);
    expect(call.p.exitCode).toBeNull();
    rmSync(hold);
    expect(await call.exited).toBe(0);
    expect(await midElement.exited).toBe(0);
    expect(readIf(logFile)).toMatch(new RegExp(`^released ${call.p.pid}$`, 'm'));
  });

  it('FAKE_GIT_HOLD with no FAKE_GIT_HOLD_REV holds the git calls naming the rev written in the hold file, and no other', async () => {
    const { binDir, logFile, env } = shims();
    const hold = join(binDir, 'git-hold');
    const sha = 'fedcba987654';
    writeFileSync(hold, `${sha}\n`);
    const held: NodeJS.ProcessEnv = { ...env, FAKE_GIT_HOLD: hold };
    delete held.FAKE_GIT_HOLD_REV;
    const call = start(join(binDir, 'git'), ['diff', '--name-only', `${sha}^{commit}`], held);
    await vi.waitFor(() => expect(readIf(logFile)).toMatch(new RegExp(`^held ${call.p.pid} git diff --name-only ${sha}`, 'm')), { timeout: 5000 });
    expect(run(join(binDir, 'git'), ['rev-parse', 'HEAD'], held).status).toBe(0);
    expect(call.p.exitCode).toBeNull();
    rmSync(hold);
    expect(await call.exited).toBe(0);
  }, 15_000);

  it('a git call naming the rev is not held once the hold file is gone', () => {
    const { binDir, env } = shims();
    const sha = 'abc123def456';
    const r = run(join(binDir, 'git'), ['diff', `${sha}..HEAD`], { ...env, FAKE_GIT_HOLD_REV: sha, FAKE_GIT_HOLD: join(binDir, 'absent') });
    expect(r.status).toBe(0);
  });
});

describe('the per-step fake agent', () => {
  const doneFile = (repo: string): string => join(repo, '.agent-terminal', 'loop', TURN_DONE_FILENAME);
  const agent = (binDir: string, repo: string) => {
    const p = spawn(join(binDir, 'fake-agent'), [], { cwd: repo });
    procs.push(p);
    return (line: string): void => {
      p.stdin.write(`${line}\n`);
    };
  };
  const turn = async (send: (l: string) => void, repo: string, key: string): Promise<void> => {
    rmSync(doneFile(repo), { force: true });
    send(`do the thing; write turn-done:${key} when finished`);
    await vi.waitFor(() => expect(readIf(doneFile(repo))).toBe(key), { timeout: 5000 });
  };

  it('scripts each step independently: attempts, per-round reports and extra shell before the done-signal', async () => {
    const binDir = tmp('fake-agent-bin-');
    const repo = tmp('fake-agent-repo-');
    const roster = ['p-one', 'p-two'];
    const sections = ['summary'];
    seedFakeAgentSteps(binDir, {
      a: {
        artifactRel: '.agent-terminal/loop/artifacts/a.md',
        work: 'complete',
        roster,
        sections,
        reviews: ['needs-human'],
        verdicts: ['a round-keyed output the attempt script must override\n'],
        consolidateAttempts: ['no verdict here\n', verdictOutput('clean')],
        extraShell: { work: ['printf one > extra-a-1', 'printf two > extra-a-2'], review: ['printf r > extra-review-1'], consolidate: ['printf c > extra-consolidate-1'] },
      },
      'a-2': { artifactRel: '.agent-terminal/loop/artifacts/a2.md', work: 'complete', roster, sections },
    });
    const send = agent(binDir, repo);

    await turn(send, repo, 'work-a');
    expect(readIf(join(repo, '.agent-terminal/loop/artifacts/a.md'))).toContain('# plan');
    expect(readIf(join(repo, 'extra-a-1'))).toBe('one');
    expect(existsSync(join(repo, 'extra-a-2'))).toBe(false);
    await turn(send, repo, 'work-a');
    expect(readIf(join(repo, 'extra-a-2'))).toBe('two');

    expect(existsSync(join(repo, 'extra-review-1'))).toBe(false);
    await turn(send, repo, 'review-a');
    expect(readIf(join(repo, 'extra-review-1'))).toBe('r');
    const report = readIf(join(repo, '.agent-terminal/loop/reports/1.json'));
    expect(roundReportWellFormed(report, { sections, roster })).toBe(true);
    expect(reportNeedsAHuman(report)).toBe(true);

    expect(existsSync(join(repo, 'extra-consolidate-1'))).toBe(false);
    await turn(send, repo, 'consolidate-a');
    expect(readIf(join(repo, 'extra-consolidate-1'))).toBe('c');
    expect(readIf(join(repo, '.agent-terminal/loop/consolidate/1.json'))).toBe('no verdict here\n');
    await turn(send, repo, 'consolidate-a');
    expect(readIf(join(repo, '.agent-terminal/loop/consolidate/1.json'))).toBe(verdictOutput('clean'));

    await turn(send, repo, 'work-a-2');
    expect(existsSync(join(repo, '.agent-terminal/loop/artifacts/a2.md'))).toBe(true);
    expect(existsSync(join(repo, 'extra-a-1'))).toBe(true);
  });

  const holdAgent = (sentinel: string) => {
    const binDir = tmp('fake-agent-bin-');
    const repo = tmp('fake-agent-repo-');
    seedFakeAgentSteps(binDir, { h: { artifactRel: '.agent-terminal/loop/artifacts/h.md', work: 'complete', hold: { sentinel } } });
    return { repo, send: agent(binDir, repo) };
  };

  it('a held work turn records its pid, keeps the agent reading, and completes only once the sentinel is deleted', async () => {
    const sentinel = join(tmp('fake-agent-hold-'), 'hold');
    writeFileSync(sentinel, '');
    const { repo, send } = holdAgent(sentinel);
    send('turn-done:work-h');
    await vi.waitFor(() => expect(readIf(`${sentinel}.pids`)).toMatch(/^\d+\n$/), { timeout: 5000 });
    send('/clear');
    await vi.waitFor(() => expect(existsSync(join(repo, '.agent-terminal/clear-seen'))).toBe(true), { timeout: 5000 });
    expect(existsSync(doneFile(repo))).toBe(false);
    rmSync(sentinel);
    await vi.waitFor(() => expect(readIf(doneFile(repo))).toBe('work-h'), { timeout: 5000 });
  });

  it('a held consolidate turn records its pid, keeps the agent reading, and writes its verdict only once the sentinel is deleted', async () => {
    const sentinel = join(tmp('fake-agent-hold-'), 'hold');
    writeFileSync(sentinel, '');
    const binDir = tmp('fake-agent-bin-');
    const repo = tmp('fake-agent-repo-');
    seedFakeAgentSteps(binDir, { h: { artifactRel: '.agent-terminal/loop/artifacts/h.md', work: 'complete', holdConsolidate: { sentinel } } });
    const send = agent(binDir, repo);
    await turn(send, repo, 'work-h');
    rmSync(doneFile(repo), { force: true });
    send('turn-done:consolidate-h');
    await vi.waitFor(() => expect(readIf(`${sentinel}.pids`)).toMatch(/^\d+\n$/), { timeout: 5000 });
    send('/clear');
    await vi.waitFor(() => expect(existsSync(join(repo, '.agent-terminal/clear-seen'))).toBe(true), { timeout: 5000 });
    expect(existsSync(doneFile(repo))).toBe(false);
    expect(existsSync(join(repo, '.agent-terminal/loop/consolidate/1.json'))).toBe(false);
    rmSync(sentinel);
    await vi.waitFor(() => expect(readIf(doneFile(repo))).toBe('consolidate-h'), { timeout: 5000 });
    expect(readIf(join(repo, '.agent-terminal/loop/consolidate/1.json'))).toBe(verdictOutput('clean'));
  }, 15_000);

  it('an abandoned hold exits with no action even when the sentinel is then deleted', async () => {
    const sentinel = join(tmp('fake-agent-hold-'), 'hold');
    writeFileSync(sentinel, '');
    const { repo, send } = holdAgent(sentinel);
    send('turn-done:work-h');
    await vi.waitFor(() => expect(readIf(`${sentinel}.pids`)).toMatch(/^\d+\n$/), { timeout: 5000 });
    const pid = Number(readIf(`${sentinel}.pids`).trim());
    writeFileSync(`${sentinel}.abandon`, '');
    rmSync(sentinel);
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 5000 });
    expect(existsSync(doneFile(repo))).toBe(false);
  });
});

describe('the feature-dev-v3 goal agent', () => {
  it('writes each run\'s result and report section where the goal prompt names them, and reports the configured run blocked', async () => {
    const binDir = tmp('v3-goal-agent-bin-');
    const repo = tmp('v3-goal-agent-repo-');
    seedV3GoalAgent(binDir, 'fake-agent', v3ImplGoals({ blocked: { green: 1 } }));
    const p = spawn(join(binDir, 'fake-agent'), [], { cwd: repo });
    procs.push(p);
    const art = '.agent-terminal/loop/artifacts';
    mkdirSync(join(repo, '.agent-terminal'), { recursive: true });
    writeFileSync(join(repo, '.agent-terminal', 'goal.green.md'), `Write ${art}/green-result.slice-2.json and ${art}/impl-report/green.slice-2.md.\n`);
    const done = join(repo, '.agent-terminal', 'loop', TURN_DONE_FILENAME);
    const progress = '.agent-terminal/loop/goal-progress.0123abcd.json';
    const goal = async (leg: number): Promise<void> => {
      rmSync(done, { force: true });
      p.stdin.write(`/goal follow .agent-terminal/goal.green.md for leg ${leg} recording ${progress} (turn-done:work-green)\n`);
      await vi.waitFor(() => expect(readIf(done)).toBe('work-green'), { timeout: 5000 });
    };

    await goal(1);
    expect(readIf(join(repo, art, 'green-result.slice-2.json'))).toBe(examplePhaseResult('passed', { build: 'built' }));
    expect(readIf(join(repo, art, 'impl-report', 'green.slice-2.md'))).toContain('run 1 of green');
    expect(JSON.parse(readIf(join(repo, progress)))).toMatchObject({ leg: 1, status: 'blocked' });

    await goal(1);
    expect(readIf(join(repo, art, 'impl-report', 'green.slice-2.md'))).toContain('run 2 of green');
    expect(JSON.parse(readIf(join(repo, progress)))).toEqual({ leg: 1, status: 'done' });
  });

  it('writes a plain work turn\'s artifact where its prompt names it', async () => {
    const binDir = tmp('v3-work-agent-bin-');
    const repo = tmp('v3-work-agent-repo-');
    seedV3GoalAgent(binDir, 'fake-agent', {}, { 'impl-approve': writePromptedArtifact(['## Needs your call', 'None.']) });
    const p = spawn(join(binDir, 'fake-agent'), [], { cwd: repo });
    procs.push(p);
    const artifact = '.agent-terminal/loop/artifacts/impl-summary.slice-2.md';
    p.stdin.write(`As the final line of your ${artifact} artifact, write EXACTLY this marker line so\nturn-done:work-impl-approve\n`);
    await vi.waitFor(() => expect(readIf(join(repo, '.agent-terminal', 'loop', TURN_DONE_FILENAME))).toBe('work-impl-approve'), { timeout: 5000 });
    expect(readIf(join(repo, artifact))).toBe('## Needs your call\nNone.\n');
  });
});

describe('the fake gh issue store', () => {
  const store = () => {
    const { binDir, ghOnlyBinDir, logFile } = seedFakeGhGit('fake-gh-store-');
    dirs.push(binDir, ghOnlyBinDir);
    const env = { ...process.env, FAKE_GHGIT_LOG: logFile };
    const gh = (args: string[], input = '', bin = binDir) => spawnSync(join(bin, 'gh'), args, { env, input, encoding: 'utf8' });
    return { binDir, ghOnlyBinDir, logFile, gh };
  };
  const source: FakeGhIssue = {
    number: 180,
    title: 'Bench-1',
    body: 'The intent.\nSecond line, no trailing newline',
    labels: ['agent-loop/ready', 'epic'],
    comments: [
      { author: 'operator', createdAt: '2026-10-19T08:00:00Z', body: 'First comment' },
      { author: 'reviewer', createdAt: '2026-10-19T09:00:00Z', body: 'Second\ncomment' },
    ],
  };

  it('serves a seeded issue with exactly the fields asked for, in gh\'s JSON shape', () => {
    const { logFile, gh } = store();
    seedFakeGhIssue(logFile, source);
    const all = gh(['issue', 'view', '180', '--repo', 'github.com/fake/repo', '--json', 'title,body,labels,comments']);
    expect(all.status).toBe(0);
    expect(JSON.parse(all.stdout)).toEqual({
      title: 'Bench-1',
      body: source.body,
      labels: [{ name: 'agent-loop/ready' }, { name: 'epic' }],
      comments: [
        { author: { login: 'operator' }, createdAt: '2026-10-19T08:00:00Z', body: 'First comment' },
        { author: { login: 'reviewer' }, createdAt: '2026-10-19T09:00:00Z', body: 'Second\ncomment' },
      ],
    });
    expect(JSON.parse(gh(['issue', 'view', '180', '--json', 'title,url']).stdout)).toEqual({ title: 'Bench-1', url: 'https://github.com/fake/repo/issues/180' });
    expect(gh(['issue', 'view', '180', '--json', 'body', '-q', '.body']).stdout).toBe(`${source.body}\n`);
    expect(gh(['issue', 'view', '180', '--json', 'nope']).status).not.toBe(0);
  });

  it('leaves an issue it does not hold to the canned answers', () => {
    const { logFile, gh } = store();
    seedFakeGhIssue(logFile, source);
    expect(JSON.parse(gh(['issue', 'view', '176', '--json', 'title,url']).stdout)).toEqual({ title: 'Fake ticket', url: 'https://github.com/fake/repo/issues/176' });
  });

  it('stores a created issue\'s title, labels and body under the next number, keeping the per-issue body sink', () => {
    const { logFile, gh } = store();
    const created = gh(['issue', 'create', '--title', 'Copy of 180', '--label', 'epic', '--label', 'bench-run,other', '--body-file', '-', '--repo', 'github.com/fake/repo'], 'copied body');
    expect(created.stdout.trim()).toBe('https://github.com/fake/repo/issues/501');
    expect(readFakeGhIssue(logFile, 501)).toEqual({ number: 501, title: 'Copy of 180', body: 'copied body', labels: ['epic', 'bench-run', 'other'], comments: [] });
    expect(readIf(`${logFile}.issue-body.501`)).toBe('copied body');
    expect(gh(['issue', 'create', '--title', 'next', '--body-file', '-'], 'b').stdout.trim()).toBe('https://github.com/fake/repo/issues/502');
  });

  it('appends each comment in order with a fixed author and a sequenced time, the same in every fresh store', () => {
    const times: string[][] = [];
    for (let k = 0; k < 2; k++) {
      const { logFile, gh } = store();
      seedFakeGhIssue(logFile, { ...source, comments: [] });
      expect(gh(['issue', 'comment', '180', '--repo', 'github.com/fake/repo', '--body-file', '-'], 'one\nline two').status).toBe(0);
      expect(gh(['issue', 'comment', '180', '--body', 'two']).status).toBe(0);
      const comments = readFakeGhIssue(logFile, 180)?.comments ?? [];
      expect(comments.map((c) => [c.author, c.body])).toEqual([['fake-user', 'one\nline two'], ['fake-user', 'two']]);
      times.push(comments.map((c) => c.createdAt));
    }
    expect(times[0][0]).not.toBe(times[0][1]);
    expect(times[1]).toEqual(times[0]);
  });

  it('refuses a comment on an issue it does not hold', () => {
    const { gh } = store();
    expect(gh(['issue', 'comment', '9', '--body', 'x']).status).not.toBe(0);
  });

  it('serves the body an issue edit wrote', () => {
    const { logFile, gh } = store();
    seedFakeGhIssue(logFile, source);
    expect(gh(['issue', 'edit', '180', '--body-file', '-', '--repo', 'github.com/fake/repo'], 'rewritten').status).toBe(0);
    expect(readFakeGhIssue(logFile, 180)?.body).toBe('rewritten');
  });

  it('lists the seeded labels, and a created one after them', () => {
    const { logFile, gh } = store();
    seedFakeGhLabels(logFile, ['epic', 'agent-loop/ready']);
    gh(['label', 'create', 'bench-run', '--description', 'A Bench-1 issue copy']);
    expect(JSON.parse(gh(['label', 'list', '--json', 'name']).stdout)).toEqual([{ name: 'epic' }, { name: 'agent-loop/ready' }, { name: 'bench-run' }]);
  });

  it('has a gh-only bin dir with no git that shares the store and the log', () => {
    const { binDir, ghOnlyBinDir, logFile, gh } = store();
    expect(existsSync(join(ghOnlyBinDir, 'git'))).toBe(false);
    gh(['issue', 'create', '--title', 'made', '--body-file', '-'], 'body', binDir);
    expect(JSON.parse(gh(['issue', 'view', '501', '--json', 'title'], '', ghOnlyBinDir).stdout)).toEqual({ title: 'made' });
    expect(readIf(logFile)).toMatch(/^gh issue create .*\ngh issue view 501 /m);
  });

  it('returns null for an issue it does not hold', () => {
    const { logFile } = store();
    expect(readFakeGhIssue(logFile, 7)).toBeNull();
  });
});

describe('the goal-session fake agent', () => {
  const doneFile = (repo: string): string => join(repo, '.agent-terminal', 'loop', TURN_DONE_FILENAME);
  const setup = (script: Parameters<typeof seedGoalSessionAgent>[2]) => {
    const { binDir, logFile } = seedFakeGhGit('goal-agent-bin-');
    dirs.push(binDir);
    const repo = tmp('goal-agent-repo-');
    seedGoalSessionAgent(binDir, 'fake-agent', script);
    const p = spawn(join(binDir, 'fake-agent'), [], { cwd: repo, env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, FAKE_GHGIT_LOG: logFile } });
    procs.push(p);
    const send = (line: string): void => void p.stdin.write(`${line}\n`);
    return { binDir, logFile, repo, send };
  };
  const goalLine = (repo: string, step: string, leg: number, prompt: string): string => {
    const rel = `.agent-terminal/loop/goal-prompt.${step}.${leg}.md`;
    mkdirSync(join(repo, '.agent-terminal', 'loop'), { recursive: true });
    writeFileSync(join(repo, rel), prompt);
    return `/goal Every instruction in ${rel} is carried out for leg ${leg} of this goal; .agent-terminal/loop/goal-progress.0123abcd.json records which (turn-done:work-${step}).`;
  };
  const awaitDone = async (repo: string, key: string): Promise<void> => {
    await vi.waitFor(() => expect(readIf(doneFile(repo))).toBe(key), { timeout: 5000 });
    rmSync(doneFile(repo));
  };

  it('runs each step\'s scripted entries in order, one per /goal, with the leg and progress file in hand', async () => {
    const { binDir, repo, send } = setup({
      goal: { groom: ['printf "%s %s\\n" "first" "$leg" >> legs', 'printf "%s %s %s\\n" "second" "$leg" "$gp" >> legs'] },
    });
    send(goalLine(repo, 'groom', 1, 'do the groom'));
    await awaitDone(repo, 'work-groom');
    send(goalLine(repo, 'groom', 2, 'carry on'));
    await awaitDone(repo, 'work-groom');
    expect(readIf(join(repo, 'legs'))).toBe('first 1\nsecond 2 .agent-terminal/loop/goal-progress.0123abcd.json\n');
    expect(readIf(join(repo, '.agent-terminal', 'goal-commands-seen')).trim().split('\n')).toHaveLength(2);
    expect(readIf(join(repo, '.agent-terminal', 'goal-prompts-seen'))).toBe('do the groomcarry on');
    expect(goalAgentOverruns(binDir)).toEqual([]);
  });

  it('records a /goal or work turn past its script as an overrun and signals nothing for it', async () => {
    const { binDir, repo, send } = setup({ goal: { groom: [':'] }, work: { 'groom-approve': [':'] } });
    send(goalLine(repo, 'groom', 1, 'p'));
    await awaitDone(repo, 'work-groom');
    send(goalLine(repo, 'groom', 2, 'p'));
    send('approve now (turn-done:work-groom-approve)');
    await awaitDone(repo, 'work-groom-approve');
    send('again (turn-done:work-groom-approve)');
    send(goalLine(repo, 'plan', 1, 'p'));
    await vi.waitFor(() => expect(goalAgentOverruns(binDir)).toEqual(['goal groom 2', 'work groom-approve 2', 'goal plan 1']), { timeout: 5000 });
    expect(existsSync(doneFile(repo))).toBe(false);
  });

  it('logs a work turn for a step it has no script for as an overrun', async () => {
    const { binDir, repo, send } = setup({ work: { plan: [':'] } });
    send('refactor now (turn-done:work-refactor)');
    send('plan (turn-done:work-plan)');
    await awaitDone(repo, 'work-plan');
    expect(goalAgentOverruns(binDir)).toEqual(['work refactor 1']);
  });

  it('answers a work turn by its own step, never a step whose id it prefixes', async () => {
    const { repo, send } = setup({ work: { plan: ['echo plan >> seen'], 'plan-approve': ['echo plan-approve >> seen'] } });
    send('approve (turn-done:work-plan-approve)');
    await awaitDone(repo, 'work-plan-approve');
    send('plan (turn-done:work-plan)');
    await awaitDone(repo, 'work-plan');
    expect(readIf(join(repo, 'seen'))).toBe('plan-approve\nplan\n');
  });

  it('saves the ticket text it read for the issue its prompt names, without the issue number or URL', async () => {
    const { logFile, repo, send } = setup({ goal: { groom: [':'] }, recordTicket: true });
    seedFakeGhIssue(logFile, {
      number: 612,
      title: 'Bench-1',
      body: 'The intent.',
      labels: ['epic', 'bench-run'],
      comments: [{ author: 'fake-user', createdAt: '2026-01-01T00:00:01Z', body: 'Originally by operator.\n\nFirst comment' }],
    });
    send(goalLine(repo, 'groom', 1, ['Intro.', ...ticketPromptLines(612)].join('\n')));
    await awaitDone(repo, 'work-groom');
    const seen = readIf(join(repo, '.agent-terminal', 'ticket-seen.groom.txt'));
    expect(seen).toContain('Bench-1');
    expect(seen).toContain('The intent.');
    expect(seen).toContain('epic');
    expect(seen).toContain('bench-run');
    expect(seen).toContain('Originally by operator.\n\nFirst comment');
    expect(seen).not.toContain('612');
    expect(seen).not.toContain('2026-01-01');
  });

  it('logs a ticket the store does not hold as unread, and leaves no ticket text to compare', async () => {
    const { binDir, repo, send } = setup({ goal: { groom: [':'] }, recordTicket: true });
    send(goalLine(repo, 'groom', 1, ticketPromptLines(613).join('\n')));
    await awaitDone(repo, 'work-groom');
    expect(goalAgentOverruns(binDir)).toEqual(['ticket-unread groom 1']);
    expect(existsSync(join(repo, '.agent-terminal', 'ticket-seen.groom.txt'))).toBe(false);
  });

  it('logs a /goal whose prompt names no ticket as unread, and still runs that /goal\'s entry', async () => {
    const { binDir, repo, send } = setup({ goal: { groom: ['echo ran >> seen'] }, recordTicket: true });
    send(goalLine(repo, 'groom', 1, 'No ticket line here.\n'));
    await awaitDone(repo, 'work-groom');
    expect(readIf(join(repo, 'seen'))).toBe('ran\n');
    expect(goalAgentOverruns(binDir)).toEqual(['ticket-unread groom 1']);
  });
});
