// #180 test infrastructure: the stand-in agent and judge, the `gh` test double, the minimal flow and the run
// helper's developer environment behave as the whole-run benchmark tests rely on.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { loadUntrustedFlowDefinition } from '../../src/main/flow';
import { artifactWellFormed, completionArtifact, completionMarker, composeAppWorkPrompt } from '../../src/main/appWorkTurn';
import { composeReviewAndFixPrompt, composeReportRepairPrompt, catalogPersonas, reviewRoster } from '../../src/main/reviewTurn';
import { appTurnKey } from '../../src/main/appTurnKey';
import { composeConsolidatePrompt, composeVerdictRepairPrompt } from '../../src/main/consolidateTurn';
import { consolidatorOutputFile, consolidatorOutputRel, roundReportFile, roundReportRel } from '../../src/main/appLoopState';
import { roundReportWellFormed } from '../../src/shared/roundReport';
import { consolidatorOutputWellFormed, exampleConsolidatorOutput, parseConsolidatorOutput } from '../../src/shared/consolidatorOutput';
import { numberFromGithubUrl } from '../../src/shared/githubUrl';
import { matchesGitHubRepositoryUrl } from '../../src/main/githubRepository';
import { userConfigLoopsV2Dir } from '../../src/main/userConfig';
import { shellQuote } from '../../src/shared/shellQuote';
import { DEFAULT_USAGE, STAND_IN_VERSION, recordPid } from '../helpers/benchStandIn/protocol';
import { createStandIn } from '../helpers/benchStandIn/harness';
import { createGhDouble } from '../helpers/benchGhDouble/harness';
import { BENCH_MINIMAL_FLOW_FILE, BENCH_MINIMAL_FLOW, installMinimalOperatorTier, minimalLoopDef } from '../helpers/benchMinimalFlow';
import { createBenchEnv, snapshotTree, type BenchEnv } from '../helpers/benchRun';

const DONE_REL = '.agent-terminal/loop/turn-done';
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runStandIn(command: string, args: string[], cwd: string, input: string, env: NodeJS.ProcessEnv = {}): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(command, args, { cwd, input, encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const agentArgs = (session: string, extra: string[] = []): string[] => ['-p', '--output-format', 'stream-json', '--verbose', '--model', 'stand-in-model', '--session-id', session, ...extra];

describe('the minimal bench flow', () => {
  it('loads through the app loader with the documented steps, skills and loop-back', () => {
    const load = loadUntrustedFlowDefinition(BENCH_MINIMAL_FLOW_FILE);
    expect(load.ok).toBe(true);
    if (!load.ok) return;
    const steps = load.definition.steps;
    expect(load.definition.name).toBe(BENCH_MINIMAL_FLOW);
    expect(steps.map((s) => [s.id, s.kind])).toEqual([
      ['m', 'manual'],
      ['a', 'loop'],
      ['b', 'loop'],
      ['c', 'loop'],
      ['d', 'loop'],
      ['z', 'manual'],
    ]);
    expect(steps.filter((s) => s.skill !== undefined).map((s) => s.id)).toEqual(['m', 'a']);
    expect(steps.find((s) => s.id === 'c')?.repeat).toEqual({ backTo: 'b', countInput: 'n' });
  });

  it('resolves every loop from the operator tier the helper installs, a with pickup and a gh approve side effect, c reading b', () => {
    const configRoot = tempDir('bench-cfg-');
    installMinimalOperatorTier(configRoot);
    expect(existsSync(join(userConfigLoopsV2Dir(configRoot)!, BENCH_MINIMAL_FLOW, 'bench-a', 'bench-a.yaml'))).toBe(true);
    const repo = tempDir('bench-repo-');
    const a = minimalLoopDef('bench-a', configRoot, repo);
    expect(a.pickup).not.toBeNull();
    expect(a.gate.find((g) => g.option === 'approve')?.sideEffects.map((s) => s.kind)).toEqual(['gh']);
    const b = minimalLoopDef('bench-b', configRoot, repo);
    const c = minimalLoopDef('bench-c', configRoot, repo);
    expect(c.inputs.map((i) => i.path)).toEqual([completionArtifact(b)!.path]);
    for (const name of ['bench-b', 'bench-c', 'bench-d']) expect(minimalLoopDef(name, configRoot, repo).pickup).toBeNull();
  });
});

describe('the stand-in agent', () => {
  it('prints a fixed version', () => {
    const s = createStandIn(tempDir('bench-si-'));
    const r = runStandIn(s.command, ['--version'], tempDir('bench-cwd-'), '');
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(STAND_IN_VERSION);
  });

  it('answers composed work, review and consolidator prompts with output the engine predicates accept', () => {
    const configRoot = tempDir('bench-cfg-');
    installMinimalOperatorTier(configRoot);
    const repo = tempDir('bench-repo-');
    const def = minimalLoopDef('bench-b', configRoot, repo);
    const artifact = completionArtifact(def)!;
    const s = createStandIn(tempDir('bench-si-'));
    const env = { CLAUDE_CONFIG_DIR: configRoot };

    const work = composeAppWorkPrompt({ recipeBody: 'Do b.', turnKey: appTurnKey('work', 'b'), doneRelPath: DONE_REL, completion: { kind: 'file', artifactRel: artifact.rel, marker: completionMarker('b') } });
    const session = randomUUID();
    const w = runStandIn(s.command, agentArgs(session), repo, work, env);
    expect(w.code, w.stderr).toBe(0);
    expect(artifactWellFormed(readFileSync(artifact.path, 'utf8'), completionMarker('b'))).toBe(true);
    expect(readFileSync(join(repo, DONE_REL), 'utf8')).toBe(appTurnKey('work', 'b'));
    const events = w.stdout.trim().split('\n').map((l) => JSON.parse(l) as { type: string; usage?: unknown });
    expect(events[0].type).toBe('system');
    expect(events.at(-1)).toMatchObject({ type: 'result', usage: { input_tokens: 100, output_tokens: 50 } });

    const review = composeReviewAndFixPrompt({ roster: reviewRoster(def), sections: def.report.sections, reportRel: roundReportRel(1), round: 1, turnKey: appTurnKey('review', 'b'), doneRelPath: DONE_REL });
    expect(runStandIn(s.command, agentArgs(randomUUID()), repo, review, env).code).toBe(0);
    const report = readFileSync(roundReportFile(repo, 1)!, 'utf8');
    expect(roundReportWellFormed(report, { sections: def.report.sections, roster: catalogPersonas(def) })).toBe(true);
    expect(s.reads().map((r) => [r.path, r.content])).toContainEqual([def.reviewers[0].charter, readFileSync(def.reviewers[0].charter, 'utf8')]);

    const consolidate = composeConsolidatePrompt({ recipeBody: 'Judge.', catalog: catalogPersonas(def), reportRels: [roundReportRel(1)], outputRel: consolidatorOutputRel(1), round: 1, turnKey: appTurnKey('consolidate', 'b'), doneRelPath: DONE_REL });
    expect(runStandIn(s.command, agentArgs(randomUUID()), repo, consolidate, env).code).toBe(0);
    const verdict = readFileSync(consolidatorOutputFile(repo, 1)!, 'utf8');
    expect(consolidatorOutputWellFormed(verdict, catalogPersonas(def))).toBe(true);
    expect(parseConsolidatorOutput(verdict)?.verdict).toBe('clean');
    expect(readFileSync(join(repo, DONE_REL), 'utf8')).toBe(appTurnKey('consolidate', 'b'));
  });

  it('writes a later round\'s report and verdict where its composed review, repair and consolidate prompts name them', () => {
    const configRoot = tempDir('bench-cfg-');
    installMinimalOperatorTier(configRoot);
    const repo = tempDir('bench-repo-');
    const def = minimalLoopDef('bench-b', configRoot, repo);
    const s = createStandIn(tempDir('bench-si-'));
    const env = { CLAUDE_CONFIG_DIR: configRoot };
    const wellFormedReport = (round: number): boolean => roundReportWellFormed(readFileSync(roundReportFile(repo, round)!, 'utf8'), { sections: def.report.sections, roster: catalogPersonas(def) });
    const wellFormedVerdict = (round: number): boolean => consolidatorOutputWellFormed(readFileSync(consolidatorOutputFile(repo, round)!, 'utf8'), catalogPersonas(def));

    const review = composeReviewAndFixPrompt({ roster: reviewRoster(def), sections: def.report.sections, reportRel: roundReportRel(2), round: 2, turnKey: appTurnKey('review', 'b'), doneRelPath: DONE_REL });
    expect(runStandIn(s.command, agentArgs(randomUUID()), repo, review, env).code).toBe(0);
    expect(wellFormedReport(2)).toBe(true);

    const repair = composeReportRepairPrompt({ problems: ['a reviewer record is missing'], roster: catalogPersonas(def), sections: def.report.sections, reportRel: roundReportRel(3), round: 3, turnKey: appTurnKey('review', 'b'), doneRelPath: DONE_REL });
    expect(runStandIn(s.command, agentArgs(randomUUID()), repo, repair, env).code).toBe(0);
    expect(wellFormedReport(3)).toBe(true);

    const consolidate = composeConsolidatePrompt({ recipeBody: 'Judge.', catalog: catalogPersonas(def), reportRels: [roundReportRel(1), roundReportRel(2)], outputRel: consolidatorOutputRel(2), round: 2, turnKey: appTurnKey('consolidate', 'b'), doneRelPath: DONE_REL });
    expect(runStandIn(s.command, agentArgs(randomUUID()), repo, consolidate, env).code).toBe(0);
    expect(wellFormedVerdict(2)).toBe(true);

    const verdictRepair = composeVerdictRepairPrompt({ problems: ['a persona line is missing'], outputRel: consolidatorOutputRel(3), catalog: catalogPersonas(def), round: 3, turnKey: appTurnKey('consolidate', 'b'), doneRelPath: DONE_REL });
    expect(runStandIn(s.command, agentArgs(randomUUID()), repo, verdictRepair, env).code).toBe(0);
    expect(wellFormedVerdict(3)).toBe(true);
    expect(readFileSync(join(repo, DONE_REL), 'utf8')).toBe(appTurnKey('consolidate', 'b'));
  });

  it('reads the inputs a composed work prompt carries and repairs a report for the roster a composed repair prompt names', () => {
    const configRoot = tempDir('bench-cfg-');
    installMinimalOperatorTier(configRoot);
    const repo = tempDir('bench-repo-');
    const def = minimalLoopDef('bench-c', configRoot, repo);
    const s = createStandIn(tempDir('bench-si-'));
    const env = { CLAUDE_CONFIG_DIR: configRoot };
    const inputRel = 'seeded/plan.md';
    mkdirSync(join(repo, 'seeded'));
    writeFileSync(join(repo, inputRel), 'the seeded plan\n');
    const work = composeAppWorkPrompt({ recipeBody: 'Do c.', turnKey: appTurnKey('work', 'c'), doneRelPath: DONE_REL, completion: null, inputs: [{ id: 'plan', rel: inputRel }] });
    expect(runStandIn(s.command, agentArgs(randomUUID()), repo, work, env).code).toBe(0);
    expect(s.reads().map((r) => [r.path, r.content])).toContainEqual([inputRel, 'the seeded plan\n']);

    const repair = composeReportRepairPrompt({ reportRel: roundReportRel(1), problems: ['a reviewer record is missing'], sections: def.report.sections, roster: catalogPersonas(def), round: 1, turnKey: appTurnKey('review', 'c'), doneRelPath: DONE_REL });
    const r = runStandIn(s.command, agentArgs(randomUUID()), repo, repair, env);
    expect(r.code, r.stderr).toBe(0);
    expect(roundReportWellFormed(readFileSync(roundReportFile(repo, 1)!, 'utf8'), { sections: def.report.sections, roster: catalogPersonas(def) })).toBe(true);
    expect(readFileSync(join(repo, DONE_REL), 'utf8')).toBe(appTurnKey('review', 'c'));
  });

  it('numbers runs by agent sandbox, so a judge call between runs leaves run 2 scripted as run 2', () => {
    const configRoot = tempDir('bench-cfg-');
    const s = createStandIn(tempDir('bench-si-'), { byRun: { '2': { turns: { [appTurnKey('work', 'b')]: [{ writes: [{ to: { rel: 'run-two' }, content: 'two' }] }] } } } });
    const work = composeAppWorkPrompt({ recipeBody: 'b', turnKey: appTurnKey('work', 'b'), doneRelPath: DONE_REL, completion: null });
    const env = { CLAUDE_CONFIG_DIR: configRoot };
    runStandIn(s.command, agentArgs(randomUUID()), tempDir('bench-repo-'), work, env);
    runStandIn(s.command, ['-p', '--tools', '', '--model', 'judge-model'], tempDir('bench-judge-'), 'grade', env);
    const repo2 = tempDir('bench-repo-');
    runStandIn(s.command, agentArgs(randomUUID()), repo2, work, env);
    expect(existsSync(join(repo2, 'run-two'))).toBe(true);
    expect(s.prompts().map((p) => p.run)).toEqual([1, 2]);
    expect(s.judgeCalls().map((j) => j.run)).toEqual([1]);
  });

  it('follows the behaviour script by turn key, occurrence and run, and logs prompts byte-for-byte from stdin', () => {
    const configRoot = tempDir('bench-cfg-');
    const s = createStandIn(tempDir('bench-si-'), {
      turns: { 'consolidate-b': [{ writes: [{ to: { round: 'consolidator' }, content: exampleConsolidatorOutput('another round', ['p']) }] }, { writes: [{ to: { round: 'consolidator' }, content: exampleConsolidatorOutput('stop for a human', ['p']) }] }] },
      byRun: { '2': { turns: { 'consolidate-b': [{ writes: [{ to: { rel: 'run-two' }, content: 'two' }] }] } } },
    });
    const marker = join(tempDir('bench-marker-'), 'pwned');
    const hostile = `$(touch ${marker})\n'; touch ${marker}; '\n\u001b[201~`;
    const prompt = (round: number): string =>
      `${composeConsolidatePrompt({ recipeBody: hostile, catalog: ['p'], reportRels: [], outputRel: consolidatorOutputRel(round), round, turnKey: 'consolidate-b', doneRelPath: DONE_REL })}`;
    const repo1 = tempDir('bench-repo-');
    runStandIn(s.command, agentArgs(randomUUID()), repo1, prompt(1), { CLAUDE_CONFIG_DIR: configRoot });
    runStandIn(s.command, agentArgs(randomUUID()), repo1, prompt(1), { CLAUDE_CONFIG_DIR: configRoot });
    expect(parseConsolidatorOutput(readFileSync(join(repo1, consolidatorOutputRel(1)), 'utf8'))?.verdict).toBe('stop for a human');
    const repo2 = tempDir('bench-repo-');
    runStandIn(s.command, agentArgs(randomUUID()), repo2, prompt(1), { CLAUDE_CONFIG_DIR: configRoot });
    expect(readFileSync(join(repo2, 'run-two'), 'utf8')).toBe('two');
    expect(existsSync(marker)).toBe(false);
    expect(s.prompts().map((p) => [p.run, p.key, p.occurrence])).toEqual([
      [1, 'consolidate-b', 1],
      [1, 'consolidate-b', 2],
      [2, 'consolidate-b', 1],
    ]);
    expect(s.prompts()[0].prompt).toBe(prompt(1));
  });

  it('refuses stream-json without --verbose and an unknown --resume, and resumes a session it started', () => {
    const configRoot = tempDir('bench-cfg-');
    const s = createStandIn(tempDir('bench-si-'), { replies: [{ shell: ['printf replied > reply-seen'] }] });
    const repo = tempDir('bench-repo-');
    const env = { CLAUDE_CONFIG_DIR: configRoot };
    expect(runStandIn(s.command, ['-p', '--output-format', 'stream-json', '--model', 'm', '--session-id', randomUUID()], repo, 'x', env).code).not.toBe(0);
    expect(runStandIn(s.command, ['-p', '--output-format', 'stream-json', '--verbose', '--resume', randomUUID()], repo, 'x', env).code).not.toBe(0);
    const session = randomUUID();
    expect(runStandIn(s.command, agentArgs(session), repo, 'hello', env).code).toBe(0);
    const resumed = runStandIn(s.command, ['-p', '--output-format', 'stream-json', '--verbose', '--resume', session], repo, 'the reply', env);
    expect(resumed.code, resumed.stderr).toBe(0);
    expect(readFileSync(join(repo, 'reply-seen'), 'utf8')).toBe('replied');
    const transcripts = readdirSync(join(configRoot, 'projects'));
    expect(transcripts).toHaveLength(1);
    const lines = readFileSync(join(configRoot, 'projects', transcripts[0], `${session}.jsonl`), 'utf8').trim().split('\n');
    expect(lines.map((l) => (JSON.parse(l) as { cwd: string }).cwd)).toEqual(lines.map(() => repo));
    expect((JSON.parse(lines.at(-1)!) as { message: { usage: unknown } }).message.usage).toEqual(DEFAULT_USAGE);
  });

  it('holds before exit until the test releases it, and logs its pid', async () => {
    const s = createStandIn(tempDir('bench-si-'), { turns: { 'work-b': [{ holdBeforeExit: 'exit-b' }] } });
    const repo = tempDir('bench-repo-');
    const prompt = composeAppWorkPrompt({ recipeBody: 'b', turnKey: 'work-b', doneRelPath: DONE_REL, completion: null });
    const child = spawn(s.command, agentArgs(randomUUID()), { cwd: repo, env: { ...process.env, CLAUDE_CONFIG_DIR: tempDir('bench-cfg-') }, stdio: ['pipe', 'ignore', 'ignore'] });
    child.stdin.end(prompt);
    const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
    await expect.poll(() => s.waiting('exit-b'), { timeout: 15_000 }).toBe(true);
    expect(readFileSync(join(repo, DONE_REL), 'utf8')).toBe('work-b');
    expect(s.livePids()).toHaveLength(1);
    s.release('exit-b');
    expect(await exited).toBe(0);
    expect(s.livePids()).toEqual([]);
  });

  it('is gone once the process it was spawned as is killed', async () => {
    const s = createStandIn(tempDir('bench-si-'), { turns: { [appTurnKey('work', 'b')]: [{ holdBeforeExit: 'never-released' }] } });
    cleanups.push(() => {
      for (const pid of s.livePids()) process.kill(pid, 'SIGKILL');
    });
    const prompt = composeAppWorkPrompt({ recipeBody: 'b', turnKey: appTurnKey('work', 'b'), doneRelPath: DONE_REL, completion: null });
    const child = spawn(s.command, agentArgs(randomUUID()), { cwd: tempDir('bench-repo-'), env: { ...process.env, CLAUDE_CONFIG_DIR: tempDir('bench-cfg-') }, stdio: ['pipe', 'ignore', 'ignore'] });
    child.stdin.end(prompt);
    await expect.poll(() => s.waiting('never-released'), { timeout: 15_000 }).toBe(true);
    child.kill('SIGKILL');
    await expect.poll(() => s.livePids(), { timeout: 5_000 }).toEqual([]);
  }, 30_000);

  it('never reports as live a recorded pid that a process other than the stand-in now holds', () => {
    const s = createStandIn(tempDir('bench-si-'));
    recordPid(s.stateDir, process.pid);
    expect(s.livePids()).toEqual([]);
  });

  it('scripts a turn to exit without its done file, hold before it, wait mid-stream, or never exit', async () => {
    const key = appTurnKey('work', 'b');
    const s = createStandIn(tempDir('bench-si-'), {
      turns: { [key]: [{ done: false, exitCode: 3 }, { holdBeforeDone: 'before-done' }, { events: [{ waitFor: 'mid-stream', text: 'later' }] }, { exit: 'never' }] },
    });
    cleanups.push(() => {
      for (const pid of s.livePids()) process.kill(pid, 'SIGKILL');
    });
    const repo = tempDir('bench-repo-');
    const cfg = tempDir('bench-cfg-');
    const prompt = composeAppWorkPrompt({ recipeBody: 'b', turnKey: key, doneRelPath: DONE_REL, completion: null });
    const done = join(repo, DONE_REL);
    const launch = (): { exited: Promise<number | null>; stdout: () => string } => {
      const child = spawn(s.command, agentArgs(randomUUID()), { cwd: repo, env: { ...process.env, CLAUDE_CONFIG_DIR: cfg }, stdio: ['pipe', 'pipe', 'ignore'] });
      let out = '';
      child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
      child.stdin.end(prompt);
      return { exited: new Promise((r) => child.on('exit', (code) => r(code))), stdout: () => out };
    };

    expect(await launch().exited).toBe(3);
    expect(existsSync(done)).toBe(false);

    const held = launch();
    await expect.poll(() => s.waiting('before-done'), { timeout: 15_000 }).toBe(true);
    expect(existsSync(done)).toBe(false);
    s.release('before-done');
    expect(await held.exited).toBe(0);
    expect(readFileSync(done, 'utf8')).toBe(key);
    rmSync(done);

    const streaming = launch();
    await expect.poll(() => s.waiting('mid-stream'), { timeout: 15_000 }).toBe(true);
    expect(streaming.stdout()).not.toContain('"type":"result"');
    s.release('mid-stream');
    expect(await streaming.exited).toBe(0);
    expect(streaming.stdout()).toContain('later');
    rmSync(done);

    launch();
    await expect.poll(() => existsSync(done), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => s.exits().length, { timeout: 2_000 }).toBe(3);
    expect(s.livePids()).toHaveLength(1);
  }, 60_000);

  it('has its turn\'s usage in the transcript before it writes the done file', async () => {
    const key = appTurnKey('work', 'b');
    const s = createStandIn(tempDir('bench-si-'), { turns: { [key]: [{ holdBeforeDone: 'usage-before-done' }] } });
    cleanups.push(() => {
      for (const pid of s.livePids()) process.kill(pid, 'SIGKILL');
    });
    const repo = tempDir('bench-repo-');
    const cfg = tempDir('bench-cfg-');
    const session = randomUUID();
    const child = spawn(s.command, agentArgs(session), { cwd: repo, env: { ...process.env, CLAUDE_CONFIG_DIR: cfg }, stdio: ['pipe', 'ignore', 'ignore'] });
    child.stdin.end(composeAppWorkPrompt({ recipeBody: 'b', turnKey: key, doneRelPath: DONE_REL, completion: null }));
    const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
    await expect.poll(() => s.waiting('usage-before-done'), { timeout: 15_000 }).toBe(true);
    expect(existsSync(join(repo, DONE_REL))).toBe(false);
    const projects = join(cfg, 'projects');
    const transcript = existsSync(projects) ? readdirSync(projects).map((d) => join(projects, d, `${session}.jsonl`)).find((f) => existsSync(f)) : undefined;
    expect(transcript, 'no transcript before the done file').toBeDefined();
    const last = readFileSync(transcript!, 'utf8').trim().split('\n').at(-1)!;
    expect((JSON.parse(last) as { message: { usage: unknown } }).message.usage).toEqual(DEFAULT_USAGE);
    s.release('usage-before-done');
    expect(await exited).toBe(0);
  }, 30_000);

  it('judges: logs env, argv and cwd and answers each rubric id named in the prompt', () => {
    const s = createStandIn(tempDir('bench-si-'), { judge: { replyById: { 'r-one': 'ONE graded', 'r-two': 'TWO graded' } } });
    const cwd = tempDir('bench-judge-');
    const r = runStandIn(s.command, ['-p', '--tools', '', '--model', 'judge-model'], cwd, 'grade r-two please', { SOME_VAR: 'x' });
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('TWO graded');
    const launch = s.launches().find((l) => l.mode === 'judge')!;
    expect(launch.cwd).toBe(cwd);
    expect(launch.argv).toEqual(['-p', '--tools', '', '--model', 'judge-model']);
    expect(launch.env.SOME_VAR).toBe('x');
    expect(s.judgeCalls().map((j) => j.reply)).toEqual(['TWO graded']);
  });
});

describe('the gh test double', () => {
  function ghEnv(gh: ReturnType<typeof createGhDouble>, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const gitConfig = join(tempDir('bench-gitcfg-'), 'config');
    writeFileSync(gitConfig, '');
    return {
      ...process.env,
      PATH: `${gh.binDir}${delimiter}${process.env.PATH ?? ''}`,
      GH_CONFIG_DIR: tempDir('bench-ghcfg-'),
      GIT_CONFIG_GLOBAL: gitConfig,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_ALLOW_PROTOCOL: 'https:file',
      GH_TOKEN: '',
      GITHUB_TOKEN: '',
      ...extra,
    };
  }
  const run = (cmd: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, input?: string): { code: number | null; stdout: string; stderr: string } => {
    const r = spawnSync(cmd, args, { env, cwd, input, encoding: 'utf8' });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };

  it('refuses and records a call made with no stored credential', () => {
    const gh = createGhDouble(tempDir('bench-gh-'));
    const env = ghEnv(gh);
    const r = run('gh', ['issue', 'edit', '1', '--repo', 'o/r', '--body', 'x'], env, tempDir('bench-cwd-'));
    expect(r.code).not.toBe(0);
    expect(gh.calls().map((c) => [c.argv.slice(0, 2), c.refused])).toEqual([[['issue', 'edit'], true]]);
  });

  it('records which credential each call used: an env token over the stored login, else the stored login', () => {
    const gh = createGhDouble(tempDir('bench-gh-'));
    const env = ghEnv(gh);
    const cwd = tempDir('bench-cwd-');
    expect(run('gh', ['auth', 'login', '--with-token'], env, cwd, 'tok-stored\n').code).toBe(0);
    expect(run('gh', ['auth', 'token'], env, cwd).stdout.trim()).toBe('tok-stored');
    expect(run('gh', ['auth', 'token'], { ...env, GH_TOKEN: 'tok-env' }, cwd).stdout.trim()).toBe('tok-env');
    expect(run('gh', ['auth', 'token'], { ...env, GITHUB_TOKEN: 'tok-env-2' }, cwd).stdout.trim()).toBe('tok-env-2');
    expect(gh.calls().slice(1).map((c) => c.credential)).toEqual(['hosts', 'env', 'env']);
  });

  it('logs in with a token, serves it to git, creates a repo a push reaches through its https URL, and an issue whose URL the app accepts', () => {
    const gh = createGhDouble(tempDir('bench-gh-'));
    const env = ghEnv(gh);
    const cwd = tempDir('bench-cwd-');
    expect(run('gh', ['auth', 'login', '--with-token', '--insecure-storage'], env, cwd, 'tok-123\n').code).toBe(0);
    expect(run('gh', ['auth', 'token'], env, cwd).stdout.trim()).toBe('tok-123');
    expect(readFileSync(join(env.GH_CONFIG_DIR!, 'hosts.yml'), 'utf8')).toContain('tok-123');
    expect(run('gh', ['auth', 'git-credential', 'get'], env, cwd, 'protocol=https\nhost=github.com\n\n').stdout).toContain('password=tok-123');

    expect(run('gh', ['repo', 'create', 'scratch/bench-one', '--private', '--description', 'bench run 1'], env, cwd).code).toBe(0);
    const work = tempDir('bench-work-');
    for (const args of [['init', '-q', '-b', 'main'], ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'seed'], ['remote', 'add', 'origin', 'https://github.com/scratch/bench-one.git'], ['push', '-q', 'origin', 'main']]) {
      const r = run('git', args, env, work);
      expect(r.code, r.stderr).toBe(0);
    }
    const head = run('git', ['rev-parse', 'HEAD'], env, work).stdout.trim();
    expect(run('git', ['ls-remote', 'https://github.com/scratch/bench-one', 'refs/heads/main'], env, cwd).stdout).toContain(head);
    expect(run('gh', ['repo', 'view', 'scratch/bench-one', '--json', 'description', '-q', '.description'], env, cwd).stdout.trim()).toBe('bench run 1');

    const marker = join(tempDir('bench-marker-'), 'pwned');
    const body = `body $(touch ${marker}) '; touch ${marker}; '\n`;
    const bodyFile = join(cwd, 'body.md');
    writeFileSync(bodyFile, body);
    const created = run('gh', ['issue', 'create', '--repo', 'scratch/bench-one', '--title', 'T', '--body-file', bodyFile], env, cwd);
    expect(created.code, created.stderr).toBe(0);
    const n = numberFromGithubUrl(created.stdout);
    expect(n).toBe(1);
    expect(matchesGitHubRepositoryUrl(created.stdout.trim(), { selector: 'github.com/scratch/bench-one', owner: 'scratch', name: 'bench-one', defaultBranch: 'main' }, 'issues', 1)).toBe(true);
    expect(run('gh', ['issue', 'view', '1', '--json', 'body', '-q', '.body'], env, work).stdout).toBe(body);
    expect(existsSync(marker)).toBe(false);
    expect(gh.issues('scratch/bench-one').map((i) => i.title)).toEqual(['T']);
  });

  it('hangs a call the test scripts to hang, and records it', async () => {
    const gh = createGhDouble(tempDir('bench-gh-'));
    const env = ghEnv(gh);
    const cwd = tempDir('bench-cwd-');
    run('gh', ['auth', 'login', '--with-token'], env, cwd, 'tok\n');
    gh.script([{ argv: ['repo', 'delete'], action: 'hang' }]);
    const child = spawn('gh', ['repo', 'delete', 'scratch/x', '--yes'], { env, cwd, stdio: 'ignore' });
    let exitedOnItsOwn = false;
    child.on('exit', (_code, signal) => (exitedOnItsOwn = signal === null));
    cleanups.push(() => child.kill('SIGKILL'));
    await expect.poll(() => gh.calls().filter((c) => c.hung).map((c) => c.argv.slice(0, 2)), { timeout: 20_000 }).toEqual([['repo', 'delete']]);
    expect(exitedOnItsOwn).toBe(false);
    expect(child.exitCode).toBeNull();
  }, 30_000);

  it('takes over a lock its dead holder left behind', () => {
    const gh = createGhDouble(tempDir('bench-gh-'));
    const env = ghEnv(gh);
    const cwd = tempDir('bench-cwd-');
    run('gh', ['auth', 'login', '--with-token'], env, cwd, 'tok\n');
    const dead = spawnSync('true').pid;
    writeFileSync(join(gh.storeDir, 'lock'), String(dead));
    const r = spawnSync('gh', ['repo', 'create', 'scratch/after-crash', '--private'], { env, cwd, encoding: 'utf8', timeout: 20_000 });
    expect(r.status, r.stderr).toBe(0);
    expect(Object.keys(gh.repos())).toEqual(['scratch/after-crash']);
  });

  it('takes over a lock a holder killed before it wrote its pid left empty', () => {
    const gh = createGhDouble(tempDir('bench-gh-'));
    const env = ghEnv(gh);
    const cwd = tempDir('bench-cwd-');
    run('gh', ['auth', 'login', '--with-token'], env, cwd, 'tok\n');
    writeFileSync(join(gh.storeDir, 'lock'), '');
    const r = spawnSync('gh', ['repo', 'create', 'scratch/after-empty-lock', '--private'], { env, cwd, encoding: 'utf8', timeout: 20_000 });
    expect(r.error).toBeUndefined();
    expect(r.status, r.stderr).toBe(0);
    expect(Object.keys(gh.repos())).toEqual(['scratch/after-empty-lock']);
  });

  it.skipIf(process.getuid?.() === 0)('fails a call at once when its store cannot be locked', () => {
    const gh = createGhDouble(tempDir('bench-gh-'));
    const env = ghEnv(gh);
    const cwd = tempDir('bench-cwd-');
    run('gh', ['auth', 'login', '--with-token'], env, cwd, 'tok\n');
    chmodSync(gh.storeDir, 0o500);
    cleanups.push(() => chmodSync(gh.storeDir, 0o700));
    const r = spawnSync('gh', ['repo', 'create', 'scratch/locked-out', '--private'], { env, cwd, encoding: 'utf8', timeout: 20_000 });
    expect(r.error).toBeUndefined();
    expect(r.status).not.toBe(0);
  });

  it('deletes a repo, or fails the delete when the test scripts it', () => {
    const gh = createGhDouble(tempDir('bench-gh-'));
    const env = ghEnv(gh);
    const cwd = tempDir('bench-cwd-');
    run('gh', ['auth', 'login', '--with-token'], env, cwd, 'tok\n');
    run('gh', ['repo', 'create', 'scratch/bench-a', '--private'], env, cwd);
    run('gh', ['repo', 'create', 'scratch/bench-b', '--private'], env, cwd);
    gh.script([{ argv: ['repo', 'delete', 'scratch/bench-b'], action: 'fail', stderr: 'HTTP 403' }]);
    expect(run('gh', ['repo', 'delete', 'scratch/bench-a', '--yes'], env, cwd).code).toBe(0);
    const failed = run('gh', ['repo', 'delete', 'scratch/bench-b', '--yes'], env, cwd);
    expect(failed.code).not.toBe(0);
    expect(failed.stderr).toContain('HTTP 403');
    expect(Object.keys(gh.repos())).toEqual(['scratch/bench-b']);
    gh.createRepoDirect('scratch/bench-planted');
    expect(Object.keys(gh.repos()).sort()).toEqual(['scratch/bench-b', 'scratch/bench-planted']);
  });
});

describe('the run helper', () => {
  let env: BenchEnv;
  afterEach(() => env?.cleanup());

  it('builds a developer environment with planted credentials, a git checkout with no origin, and the double and sentinels on PATH', () => {
    vi.stubEnv('LANG', 'de_DE.UTF-8');
    vi.stubEnv('LC_ALL', 'de_DE.UTF-8');
    env = createBenchEnv();
    vi.unstubAllEnvs();
    for (const name of ['SSH_AUTH_SOCK', 'CLAUDE_CODE_OAUTH_TOKEN', 'GH_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'BENCHMARK_GH_TOKEN']) expect(env.env[name]).toBeTruthy();
    expect(env.env.INIT_CWD).toBe(env.checkout);
    expect([env.env.LANG, env.env.LC_ALL]).toEqual(['C.UTF-8', 'C.UTF-8']);
    expect(env.env.BENCHMARK_CLAUDE_CONFIG_DIR).toBe(env.benchConfigDir);
    expect(env.env.CLAUDE_CONFIG_DIR).toBe(env.devConfigDir);
    expect(new Set([env.env.HOME, env.env.APP_HOME_DIR, env.devConfigDir, env.benchConfigDir]).size).toBe(4);
    const which = (cmd: string): string => spawnSync('bash', ['--noprofile', '--norc', '-c', `command -v ${cmd}`], { env: env.env, encoding: 'utf8' }).stdout.trim();
    expect(which('gh')).toBe(join(env.gh.binDir, 'gh'));
    expect(which('ssh')).toBe(env.sentinels.ssh);
    expect(spawnSync('git', ['remote'], { cwd: env.checkout, env: env.env, encoding: 'utf8' }).stdout.trim()).toBe('');
    expect(readdirSync(env.devAuditDir)).toHaveLength(1);
    expect(readFileSync(env.configFile, 'utf8')).toContain(env.standIn.command);
    expect(existsSync(join(userConfigLoopsV2Dir(env.benchConfigDir)!, BENCH_MINIMAL_FLOW, 'bench-a', 'bench-a.yaml'))).toBe(true);
  });

  it('can start with the benchmark config root and its parent absent, and makes path arguments absolute', () => {
    env = createBenchEnv({ benchConfigRoot: 'absent' });
    expect(existsSync(env.benchConfigDir)).toBe(false);
    expect(existsSync(join(env.benchConfigDir, '..'))).toBe(false);
    expect(env.args({ flow: 'example/flows/feature-dev-v2/flow.yaml', span: 'b', fixture: 'tests/fixtures/bench/scenarios/basic' })).toEqual(
      expect.arrayContaining(['--flow', join(env.repoRoot, 'example/flows/feature-dev-v2/flow.yaml'), '--fixture', join(env.repoRoot, 'tests/fixtures/bench/scenarios/basic'), '--out', env.outDir, '--config', env.configFile]),
    );
  });

  it('resolves a spawn that cannot start instead of throwing', async () => {
    env = createBenchEnv();
    env.env.PATH = env.sentinels.dir;
    const r = await env.spawn([]);
    expect(r.code).toBeNull();
    expect(r.stderr).toContain('ENOENT');
  }, 30_000);

  it('kills a still-running bench process group on cleanup', async () => {
    env = createBenchEnv();
    const fakeBin = join(env.root, 'fake-pnpm');
    mkdirSync(fakeBin);
    const pidFile = join(env.root, 'grandchild.pid');
    writeFileSync(join(fakeBin, 'pnpm'), `#!/usr/bin/env bash\nsleep 300 &\necho $! > ${shellQuote(pidFile)}\nwait\n`);
    chmodSync(join(fakeBin, 'pnpm'), 0o755);
    env.env.PATH = `${fakeBin}${delimiter}${env.env.PATH}`;
    const finished = env.spawn([]);
    await expect.poll(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '', { timeout: 15_000 }).toBe(true);
    const grandchild = Number(readFileSync(pidFile, 'utf8'));
    env.cleanup();
    await finished;
    const alive = (): boolean => {
      try {
        process.kill(grandchild, 0);
        return true;
      } catch {
        return false;
      }
    };
    await expect.poll(alive, { timeout: 5_000 }).toBe(false);
  }, 30_000);

  it.each([
    ['an outer COREPACK_HOME', { COREPACK_HOME: '/outer/corepack', XDG_CACHE_HOME: '/outer/xdg' }, '/outer/corepack'],
    ['only an outer XDG_CACHE_HOME', { COREPACK_HOME: undefined, XDG_CACHE_HOME: '/outer/xdg' }, join('/outer/xdg', 'node', 'corepack')],
    ['neither', { COREPACK_HOME: undefined, XDG_CACHE_HOME: undefined }, join(homedir(), '.cache', 'node', 'corepack')],
  ])('hands a corepack pnpm the outer cache, offline, given %s', async (_, outer, expected) => {
    for (const [name, value] of Object.entries(outer)) vi.stubEnv(name, value);
    try {
      env = createBenchEnv();
    } finally {
      vi.unstubAllEnvs();
    }
    const fakeBin = join(env.root, 'fake-pnpm');
    mkdirSync(fakeBin);
    writeFileSync(join(fakeBin, 'pnpm'), '#!/usr/bin/env bash\nprintf \'%s\\n%s\\n\' "$COREPACK_HOME" "$COREPACK_ENABLE_NETWORK"\n');
    chmodSync(join(fakeBin, 'pnpm'), 0o755);
    env.env.PATH = `${fakeBin}${delimiter}${env.env.PATH}`;
    const r = await env.spawn([]);
    expect(r.stdout.split('\n').slice(0, 2)).toEqual([expected, '0']);
  }, 30_000);

  it('kills a bench process group on cleanup after its leader has exited', async () => {
    env = createBenchEnv();
    const fakeBin = join(env.root, 'fake-pnpm');
    mkdirSync(fakeBin);
    const pidFile = join(env.root, 'orphan.pid');
    writeFileSync(join(fakeBin, 'pnpm'), `#!/usr/bin/env bash\nsleep 300 </dev/null >/dev/null 2>&1 &\necho $! > ${shellQuote(pidFile)}\n`);
    chmodSync(join(fakeBin, 'pnpm'), 0o755);
    env.env.PATH = `${fakeBin}${delimiter}${env.env.PATH}`;
    const r = await env.spawn([]);
    expect(r.code).toBe(0);
    const orphan = Number(readFileSync(pidFile, 'utf8'));
    const alive = (): boolean => {
      try {
        process.kill(orphan, 0);
        return true;
      } catch {
        return false;
      }
    };
    expect(alive()).toBe(true);
    env.cleanup();
    await expect.poll(alive, { timeout: 5_000 }).toBe(false);
  }, 30_000);

  it('snapshots a tree so any byte change is visible', () => {
    const dir = tempDir('bench-snap-');
    writeFileSync(join(dir, 'f'), 'a');
    const before = snapshotTree(dir);
    expect(snapshotTree(dir)).toBe(before);
    writeFileSync(join(dir, 'f'), 'b');
    expect(snapshotTree(dir)).not.toBe(before);
  });

  it('tells an absent tree from an empty one', () => {
    const parent = tempDir('bench-snap-');
    const dir = join(parent, 'd');
    const absent = snapshotTree(dir);
    mkdirSync(dir);
    expect(snapshotTree(dir)).not.toBe(absent);
  });
});
