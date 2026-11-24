import { reviewerCatalog } from '../helpers/reviewerCatalog';
import { markRunReviewersLoaded } from '../helpers/runReviewerSession';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createAppLoopEngineHarness, STEP, TURN_KEY } from '../helpers/appLoopEngineHarness';
import { unrunnableReviewers, reconcileRunReviewers } from '../../src/main/runReviewers';
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
    reconcileRunReviewers(h.repo, reviewerCatalog(reviewRoster(def)));
    let sessionStartedAt = markRunReviewersLoaded(h.repo);
    const engine = h.makeEngine(undefined, undefined, undefined, {
      ensureReviewerInstallation: (repo) => reconcileRunReviewers(repo, h.defResult.ok ? reviewerCatalog(reviewRoster(h.defResult.def), h.defResult.definitionFile) : reviewerCatalog([])).problems,
      unrunnableReviewers: (repo, reviewers, kind) => unrunnableReviewers(kind, repo, reviewers, { codexAgentsDir: null, sessionStartedAt: () => sessionStartedAt }),
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
    const current = reviewRoster(def);
    expect.soft(engine.liveErrorFor(h.repo)?.reason).toContain(change === 'empty-tools' ? current[0].loop : current[0].charter);
    expect.soft(readAppLoopState(h.repo)?.status).toBe('error');
    expect.soft(engine.liveErrorFor(h.repo)?.reason).toMatch(/restore|correct|repair|replace|fix/i);
    expect.soft(engine.liveErrorFor(h.repo)?.reason).toMatch(/retry/i);
    const isReview = (prompt: string) => mode === 'goal' ? prompt.startsWith('/goal ') : prompt.includes('review-and-fix turn');
    expect.soft(h.injected.filter(isReview)).toEqual([]);
    engine.routeOut(h.repo, STEP, TURN_KEY, 'retry');
    engine.onInjectable();
    engine.onInjectable();
    expect.soft(h.injected.filter(isReview)).toEqual([]);
    if (change === 'directory') rmSync(def.reviewers[0].charter, { recursive: true });
    writeFileSync(def.reviewers[0].charter, 'Repaired instructions.\n');
    def.reviewers[0].tools = ['Read'];
    h.defResult = h.resolved(def);
    reconcileRunReviewers(h.repo, reviewerCatalog(reviewRoster(def)));
    sessionStartedAt = markRunReviewersLoaded(h.repo);
    engine.routeOut(h.repo, STEP, TURN_KEY, 'retry');
    engine.onInjectable();
    engine.onInjectable();
    if (mode === 'ordinary') {
      h.writeArtifact(true);
      engine.onDoneSignal();
      engine.onInjectable();
      engine.onInjectable();
    }
    expect.soft(engine.liveErrorFor(h.repo)).toBeNull();
    expect.soft(h.injected.some(isReview)).toBe(true);
    const prompt = mode === 'goal' ? readFileSync(join(h.repo, '.agent-terminal/loop/goal-prompt.md'), 'utf8') : h.injected.find(isReview) ?? '';
    for (const reviewer of reviewRoster(def)) expect.soft(prompt).toContain(reviewerAgentFor('claude-code', reviewer));
    expect(prompt).toContain(def.reviewers[0].persona);
  });
}
