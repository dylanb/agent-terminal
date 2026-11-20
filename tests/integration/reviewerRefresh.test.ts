import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createAppLoopEngineHarness, REVIEW_KEY, STEP, TURN_KEY } from '../helpers/appLoopEngineHarness';
import { ensureReviewersRunnable, ensureRunReviewers, runAgentsDir } from '../../src/main/runReviewers';
import { reviewRoster, reviewerAgentFor, rosterLines } from '../../src/main/reviewTurn';
import { readAppLoopState } from '../../src/main/appLoopState';
import { seedFakeAgentSteps } from '../e2e/fakeTools';
import { installedReviewerProblem } from '../../src/main/reviewerAgents';

const h = createAppLoopEngineHarness();
beforeEach(h.setUp);
afterEach(h.tearDown);

for (const mode of ['ordinary', 'goal'] as const) {
  it.each(['charter', 'tools', 'deleted'] as const)(`${mode} refresh after a completed review: %s`, (change) => {
    const def = h.fileDef();
    for (const reviewer of def.reviewers) {
      mkdirSync(dirname(reviewer.charter), { recursive: true });
      writeFileSync(reviewer.charter, `${reviewer.persona} original instructions.\n`);
    }
    h.defResult = h.resolved(def);
    ensureRunReviewers(h.repo, reviewRoster(def), '');
    const agents = runAgentsDir(h.repo).dir;
    for (const file of readdirSync(agents)) utimesSync(join(agents, file), new Date(0), new Date(0));
    let sessionStartedAt = 1;
    const engine = h.makeEngine(undefined, undefined, undefined, {
      ensureReviewersRunnable: (repo, reviewers, kind) => ensureReviewersRunnable(kind, repo, reviewers, { bundleDir: '', codexAgentsDir: null, sessionStartedAt: () => sessionStartedAt }),
    });
    h.enterAndInjectWork(engine);
    h.driveFromWorkToGate(engine);
    expect(readAppLoopState(h.repo)?.status).toBe('complete');
    if (change === 'charter') writeFileSync(def.reviewers[0].charter, 'Updated charter.\n');
    if (change === 'tools') def.reviewers[0].tools = ['Grep'];
    if (change === 'deleted') for (const file of readdirSync(agents)) rmSync(join(agents, file));
    if (mode === 'goal') {
      def.work = { ...def.work, goal: 'Review the current result' };
      def.rounds = { kind: 'none' };
    }
    h.defResult = h.resolved(def);
    h.injected.length = 0;
    h.enterAndInjectWork(engine);
    if (mode === 'ordinary') {
      h.writeArtifact(true);
      engine.onDoneSignal();
      engine.onInjectable();
      engine.onInjectable();
    }
    const current = reviewRoster(def);
    expect.soft(engine.liveErrorFor(h.repo)?.reason).toContain(reviewerAgentFor('claude-code', current[0]));
    expect.soft(readAppLoopState(h.repo)?.status).toBe('error');
    expect.soft(engine.liveErrorFor(h.repo)?.reason).toMatch(/restart.*session/i);
    const isReview = (prompt: string) => mode === 'goal' ? prompt.startsWith('/goal ') : prompt.includes('review-and-fix turn');
    expect.soft(h.injected.filter(isReview)).toEqual([]);
    for (const reviewer of current) expect.soft(installedReviewerProblem(runAgentsDir(h.repo), reviewer)).toBeNull();
    engine.routeOut(h.repo, STEP, mode === 'goal' ? TURN_KEY : REVIEW_KEY, 'retry');
    engine.onInjectable();
    engine.onInjectable();
    expect.soft(h.injected.filter(isReview)).toEqual([]);
    sessionStartedAt = Math.max(...readdirSync(agents).map((file) => statSync(join(agents, file)).mtimeMs)) + 1;
    engine.routeOut(h.repo, STEP, mode === 'goal' ? TURN_KEY : REVIEW_KEY, 'retry');
    engine.onInjectable();
    engine.onInjectable();
    expect.soft(engine.liveErrorFor(h.repo)).toBeNull();
    expect.soft(h.injected.some(isReview)).toBe(true);
    const prompt = mode === 'goal' ? readFileSync(join(h.repo, '.agent-terminal/loop/goal-prompt.md'), 'utf8') : h.injected.find(isReview) ?? '';
    for (const reviewer of current) expect.soft(prompt).toContain(reviewerAgentFor('claude-code', reviewer));
    expect(prompt).toContain(def.reviewers[0].persona);
  });
}

for (const hasIgnore of [false, true]) {
  it(`refresh preserves another real worktree, global agents and git exclusion (gitignore: ${hasIgnore})`, () => {
    const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
    git(h.repo, 'init', '-q');
    git(h.repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'root');
    const other = `${h.repo}-other`;
    git(h.repo, 'worktree', 'add', '-qb', 'other', other);
    try {
      const global = join(h.repo, 'global-agents');
      mkdirSync(global);
      writeFileSync(join(global, 'mine.md'), 'Global instructions.');
      const exclude = join(h.repo, '.git/info/exclude');
      writeFileSync(exclude, 'operator-owned/\n');
      const specs = [h.repo, other].map((repo, i) => {
        const charter = join(repo, 'charter.md');
        writeFileSync(charter, `Worktree ${i}.`);
        if (hasIgnore) writeFileSync(join(repo, '.gitignore'), 'build/\n');
        const reviewer = { loop: 'same-loop', persona: 'same-reviewer', charter, tools: ['Read'] };
        ensureRunReviewers(repo, [reviewer], '');
        writeFileSync(join(runAgentsDir(repo).dir, 'unrelated.md'), 'Unrelated reviewer.');
        return reviewer;
      });
      const snapshot = () => readdirSync(runAgentsDir(other).dir).map((file) => [file, readFileSync(join(runAgentsDir(other).dir, file), 'utf8')]);
      const original = snapshot();
      const evidence = join(h.repo, 'executed.jsonl');
      const expected = { name: reviewerAgentFor('claude-code', specs[1]), persona: specs[1].persona, charter: 'Worktree 1.', tools: ['Read'] };
      const bin = join(h.repo, 'bin');
      mkdirSync(bin);
      seedFakeAgentSteps(bin, { check: { artifactRel: '.agent-terminal/loop/artifacts/result.md', work: 'complete', roster: ['same-reviewer'] } }, { reviewers: { expected: [expected], evidence } });
      for (const change of ['charter', 'tools', 'deleted']) {
        if (change === 'charter') writeFileSync(specs[0].charter, 'Refreshed first worktree.');
        if (change === 'tools') specs[0].tools = ['Grep'];
        if (change === 'deleted') for (const file of readdirSync(runAgentsDir(h.repo).dir).filter((f) => f !== 'unrelated.md')) rmSync(join(runAgentsDir(h.repo).dir, file));
        ensureRunReviewers(h.repo, [specs[0]], '');
        expect.soft(installedReviewerProblem(runAgentsDir(h.repo), specs[0])).toBeNull();
        expect.soft(snapshot()).toEqual(original);
        expect.soft(installedReviewerProblem(runAgentsDir(other), specs[1])).toBeNull();
        for (const repo of [h.repo, other]) {
          expect.soft(git(repo, 'status', '--porcelain', '--untracked-files=all', '--', '.claude/agents')).toBe('?? .claude/agents/unrelated.md\n');
          expect.soft(readFileSync(join(runAgentsDir(repo).dir, 'unrelated.md'), 'utf8')).toBe('Unrelated reviewer.');
          expect.soft(hasIgnore ? readFileSync(join(repo, '.gitignore'), 'utf8') : readdirSync(repo).includes('.gitignore')).toBe(hasIgnore ? 'build/\n' : false);
        }
      }
      try { execFileSync('bash', [join(bin, 'fake-agent')], { cwd: other, input: [...rosterLines([specs[1]], 'claude-code'), ''].join('\n'), stdio: ['pipe', 'pipe', 'pipe'] }); } catch {}
      expect.soft(existsSync(evidence) ? readFileSync(evidence, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []).toEqual([{ name: expected.name, charter: 'Worktree 1.', tools: ['Read'] }]);
      expect.soft(readFileSync(exclude, 'utf8')).toContain('operator-owned/\n');
      expect(readdirSync(global).map((file) => readFileSync(join(global, file), 'utf8'))).toEqual(['Global instructions.']);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
}
