import { describe, expect, it, onTestFinished } from 'vitest';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runAppGateDecision, type AppGateDecisionDeps } from '../../src/main/appGateDecision';
import { resolveAppGateRefs } from '../../src/main/appLoopBootstrap';
import { createRealAppGateGitHub } from '../../src/main/appGateGithub';
import { createRealAppGateCommit } from '../../src/main/appGateCommit';
import { createRealAppGatePush } from '../../src/main/appGatePush';
import { runAdoptionStart } from '../../src/main/adoptionStart';
import { createRealAdoptionGit, createRealAdoptionGitHub } from '../../src/main/adoptionPorts';
import { clearAppLoopBootstrap, writeAdoptedPickup, writeAdoptedPickupIntent, type AppLoopRunState } from '../../src/main/appLoopState';
import type { AdoptedPickup } from '../../src/shared/appBootstrap';
import type { GateOptionDef, LoopDefV2 } from '../../src/main/loopDefV2';
import { createAdoptionWorld, type AdoptionWorld } from '../helpers/adoptionWorld';
import { outwardWrites } from '../helpers/outwardWrites';

// #304 slice 2 — the ticket-run gate effects never act for a run that adopted a PR: approving at its gate with
// `mark-ready`, `update-issue-body` or `publish-pr-body` writes nothing and holds the gate, and its `commit` lands
// locally without a push. The run is started by the real adoption start in the adoption world, and the gate runs
// the app's real side-effect executors against its git and gh stand-in.

const STEP = 'review';
const TURN_KEY = 'consolidate-review';
const AT_GATE: AppLoopRunState = { loop: 'plan-loop', step: STEP, turnKey: TURN_KEY, status: 'complete', round: 1, verdict: 'clean' };

interface Adopted {
  w: AdoptionWorld;
  pickup: AdoptedPickup;
  report: string;
}

async function adoptedRun(): Promise<Adopted> {
  const w = createAdoptionWorld({ prefix: 'adopted-gate' });
  onTestFinished(({ task }) => {
    try {
      w.dispose();
    } catch (e) {
      if (task.result?.state !== 'fail') throw e;
    }
  });
  w.activate();
  appendFileSync(join(w.repo, '.git', 'info', 'exclude'), '.agent-terminal/\n');
  const started = await runAdoptionStart(
    {
      git: createRealAdoptionGit(w.repo),
      github: createRealAdoptionGitHub(w.repo),
      prepareRecord: (intent) => writeAdoptedPickupIntent(w.repo, intent),
      writeRecord: (pickup) => writeAdoptedPickup(w.repo, pickup),
      clearRecord: () => clearAppLoopBootstrap(w.repo),
    },
    { pr: w.prNumber, startedAt: 1_700_000_000_000 },
  );
  if (!started.ok) throw new Error(`the adoption start was refused: ${started.kind === 'error' ? started.error : started.kind}`);
  const report = join(w.repo, '.agent-terminal', 'report.md');
  writeFileSync(report, 'A report this run wrote.\n');
  return { w, pickup: started.identity, report };
}

interface Outcome {
  accepted: number;
  advanced: number;
  errors: string[];
}

async function approve(run: Adopted, gate: GateOptionDef[]): Promise<Outcome> {
  const outcome: Outcome = { accepted: 0, advanced: 0, errors: [] };
  const def = { gate, inputs: [], outputs: [{ id: 'report', path: run.report }], work: { recipe: '/r', artifact: 'report' } } as unknown as LoopDefV2;
  const deps: AppGateDecisionDeps = {
    readRunState: () => AT_GATE,
    resolveDef: () => ({ ok: true, def, tierRoot: run.w.repo, defDir: run.w.repo }),
    refs: () => resolveAppGateRefs({ pr: run.w.prNumber }, run.pickup),
    runSideEffect: createRealAppGateGitHub(run.w.repo),
    runCommitSideEffect: createRealAppGateCommit(run.w.repo),
    runPushSideEffect: createRealAppGatePush(run.w.repo),
    failureHoldsGate: () => true,
    assembleReport: () => {},
    recordBaseline: () => {},
    persistAccept: () => void (outcome.accepted += 1),
    advanceFlow: () => void (outcome.advanced += 1),
    audit: () => {},
    emitError: (reason) => void outcome.errors.push(reason),
    emitNotice: () => {},
    onViewChanged: () => {},
    deliverFeedback: () => true,
    deliverRedo: () => true,
    enterPolish: () => {},
    clearPolish: () => {},
    reopenSlice: () => false,
    recordSliceBrief: () => {},
    clearSliceBrief: () => {},
    reopenStep: () => null,
    sourceSliceCount: () => {},
    maybeBeginEpicPromotion: () => ({ kind: 'not-epic' }),
    readStepDecision: () => ({ kind: 'none' }),
    recordDecision: () => ({ undo: () => true }),
    auditDecision: () => undefined,
  };
  await runAppGateDecision(run.w.repo, STEP, TURN_KEY, 'approve', deps);
  return outcome;
}

describe("an adopted run's gate refuses the ticket-run effects, writing nothing (#304 AC 26)", () => {
  it.each(['mark-ready', 'update-issue-body', 'publish-pr-body'])('%s writes nothing to GitHub and holds the gate', async (action) => {
    const run = await adoptedRun();
    const before = run.w.calls().length;

    const outcome = await approve(run, [{ option: 'approve', sideEffects: [{ kind: 'gh', args: { action, artifact: 'report' } }] }]);

    expect.soft(outwardWrites(run.w.calls().slice(before))).toEqual([]);
    expect.soft(outcome.accepted).toBe(0);
    expect.soft(outcome.advanced).toBe(0);
    expect.soft(outcome.errors).toHaveLength(1);
  });
});

describe("an adopted run's gate commit stays local (#304 AC 8)", () => {
  it('commits the fix onto the fix branch and pushes nothing', async () => {
    const run = await adoptedRun();
    writeFileSync(join(run.w.repo, 'change.txt'), 'the fix this run made\n');
    const before = run.w.calls().length;

    const outcome = await approve(run, [{ option: 'approve', sideEffects: [{ kind: 'commit', args: { label: 'Review fixes' } }] }]);

    expect.soft(run.w.git(run.w.repo, ['rev-parse', `${run.pickup.fixBranch}^`])).toBe(run.w.startHeadOid);
    expect.soft(run.w.git(run.w.repo, ['show', `${run.pickup.fixBranch}:change.txt`])).toBe('the fix this run made');
    expect.soft(outwardWrites(run.w.calls().slice(before))).toEqual([]);
    expect.soft(run.w.remoteRef(`refs/heads/${run.pickup.fixBranch}`)).toBeNull();
    expect.soft(outcome.accepted).toBe(1);
  });
});
