import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LoopDefV2 } from '../../src/main/loopDefV2';
import type { RepeatEntry } from '../../src/shared/repeatList';
import { createAppLoopEngineHarness, STEP } from '../helpers/appLoopEngineHarness';

// §28.4.1 — which of a repeated step's turns name the list entry the run is on: every work turn, a goal
// session's included, and never a review-and-fix or consolidate turn.

const h = createAppLoopEngineHarness();
const { resolved, makeEngine, fileDef } = h;

beforeEach(h.setUp);
afterEach(h.tearDown);

const ENTRY_LINE = /^entry \d+ of \d+: .*$/gm;
const ENTRY: RepeatEntry = { position: 2, count: 3, title: 'Render the table' };
/** The entry the run is on for this test's repository and step, and none for any other. */
const onStep = (repoDir: string, stepId: string): RepeatEntry | null => (repoDir === h.repo && stepId === STEP ? ENTRY : null);
const entryLines = (prompt: string): string[] => prompt.match(ENTRY_LINE) ?? [];
const lastInjected = (): string => h.injected[h.injected.length - 1];

describe('a repeated step names its entry on its work turns only', () => {
  it('the work prompt names the entry, while the review-and-fix and consolidate prompts of the same run name none', () => {
    h.defResult = resolved(fileDef());
    const engine = makeEngine(undefined, undefined, undefined, { repeatEntry: onStep });
    h.enterAndInjectWork(engine);
    const work = lastInjected();
    h.writeArtifact(true);
    engine.onDoneSignal();
    engine.onInjectable();
    engine.onInjectable();
    const review = lastInjected();
    h.writeRoundReport(1);
    engine.onDoneSignal();
    engine.onInjectable();
    engine.onInjectable();
    const consolidate = lastInjected();
    expect({ work: entryLines(work), review: entryLines(review), reviewIsReview: review.includes('review-and-fix'), consolidate: entryLines(consolidate), distinct: new Set([work, review, consolidate]).size }).toEqual({
      work: ['entry 2 of 3: Render the table'],
      review: [],
      reviewIsReview: true,
      consolidate: [],
      distinct: 3,
    });
  });

  it("a goal session's work prompt names the entry", () => {
    const base = fileDef();
    const goalDef: LoopDefV2 = { ...base, work: { ...base.work, goal: 'the latest review pass returned no findings' }, rounds: { kind: 'none' } };
    h.defResult = resolved(goalDef);
    const engine = makeEngine(undefined, undefined, undefined, { repeatEntry: onStep });
    h.enterAndInjectWork(engine);
    const goal = h.injected.filter((p) => p.startsWith('/goal ')).at(-1) ?? '';
    const rel = /\.agent-terminal\/\S+\.md/.exec(goal)?.[0];
    const prompt = rel === undefined ? `no goal prompt file in ${JSON.stringify(goal)}` : readFileSync(join(h.repo, rel), 'utf8');
    expect(entryLines(prompt)).toEqual(['entry 2 of 3: Render the table']);
  });

  it('a work turn the run names no entry for carries no entry line', () => {
    h.defResult = resolved(fileDef());
    const engine = makeEngine(undefined, undefined, undefined, { repeatEntry: () => null });
    h.enterAndInjectWork(engine);
    expect(entryLines(lastInjected())).toEqual([]);
  });
});
