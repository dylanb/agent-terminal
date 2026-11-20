import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createAppLoopEngineHarness, REVIEW_KEY, STEP, TURN_KEY } from '../helpers/appLoopEngineHarness';
import { ensureReviewersRunnable, ensureRunReviewers, runAgentsDir } from '../../src/main/runReviewers';
import { reviewRoster, reviewerAgentFor } from '../../src/main/reviewTurn';
import { readAppLoopState } from '../../src/main/appLoopState';

const h = createAppLoopEngineHarness();
beforeEach(h.setUp);
afterEach(h.tearDown);

for (const mode of ['ordinary', 'goal'] as const) {
  it.each(['missing', 'directory', 'empty-tools'] as const)(`${mode} broken-source recovery after a completed review: %s`, (change) => {
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
    if (change === 'missing' || change === 'directory') rmSync(def.reviewers[0].charter);
    if (change === 'directory') mkdirSync(def.reviewers[0].charter);
    if (change === 'empty-tools') def.reviewers[0].tools = [];
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
    expect.soft(engine.liveErrorFor(h.repo)?.reason).toContain(current[0].charter);
    expect.soft(readAppLoopState(h.repo)?.status).toBe('error');
    expect.soft(engine.liveErrorFor(h.repo)?.reason).toMatch(/restore|correct|repair|replace|fix/i);
    expect.soft(engine.liveErrorFor(h.repo)?.reason).toMatch(/retry/i);
    const isReview = (prompt: string) => mode === 'goal' ? prompt.startsWith('/goal ') : prompt.includes('review-and-fix turn');
    expect.soft(h.injected.filter(isReview)).toEqual([]);
    engine.routeOut(h.repo, STEP, mode === 'goal' ? TURN_KEY : REVIEW_KEY, 'retry');
    engine.onInjectable();
    engine.onInjectable();
    expect.soft(h.injected.filter(isReview)).toEqual([]);
    if (change === 'directory') rmSync(def.reviewers[0].charter, { recursive: true });
    writeFileSync(def.reviewers[0].charter, 'Repaired instructions.\n');
    def.reviewers[0].tools = ['Read'];
    ensureRunReviewers(h.repo, reviewRoster(def), '');
    sessionStartedAt = Math.max(...readdirSync(agents).map((file) => statSync(join(agents, file)).mtimeMs)) + 1;
    engine.routeOut(h.repo, STEP, mode === 'goal' ? TURN_KEY : REVIEW_KEY, 'retry');
    engine.onInjectable();
    engine.onInjectable();
    expect.soft(engine.liveErrorFor(h.repo)).toBeNull();
    expect.soft(h.injected.some(isReview)).toBe(true);
    const prompt = mode === 'goal' ? readFileSync(join(h.repo, '.agent-terminal/loop/goal-prompt.md'), 'utf8') : h.injected.find(isReview) ?? '';
    for (const reviewer of reviewRoster(def)) expect.soft(prompt).toContain(reviewerAgentFor('claude-code', reviewer));
    expect(prompt).toContain(def.reviewers[0].persona);
  });
}
