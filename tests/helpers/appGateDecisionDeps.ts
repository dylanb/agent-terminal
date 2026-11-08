// The §27 gate-decision executor's ports as fakes that record what each one was asked to do, for tests that drive
// `runAppApprove` or `runAppGateDecision` directly.

import type { AppGateDecisionDeps } from '../../src/main/appGateDecision';
import type { AppLoopBootstrap, AppLoopRunState } from '../../src/main/appLoopState';
import type { GateOptionDef, LoopDefV2 } from '../../src/main/loopDefV2';
import type { AppGateCommitCtx } from '../../src/main/appGateCommit';

export const GATE_RUN: AppLoopRunState = {
  loop: 'plan-loop',
  step: 'plan',
  turnKey: 'consolidate-plan',
  status: 'complete',
  round: 2,
  verdict: 'clean',
};

export const defWithGate = (gate: GateOptionDef[]): LoopDefV2 => ({ gate, outputs: [], work: { recipe: '/r', artifact: 'commits' } } as unknown as LoopDefV2);
export const APPROVE_MARK_READY: GateOptionDef[] = [{ option: 'approve', sideEffects: [{ kind: 'gh', args: { action: 'mark-ready' } }] }];

export interface Recorder {
  sideEffects: Array<{ action: string; ctx: unknown }>;
  commitSideEffects: AppGateCommitCtx[];
  accepts: AppLoopRunState[];
  advances: string[];
  audits: Array<{ cmd: string; exit: number | null }>;
  errors: string[];
  notices: string[];
  views: number;
  feedbacks: Array<{ step: string; turnKey: string; feedback: string }>;
  redos: Array<{ step: string; turnKey: string; instruction: string }>;
  polishEnters: Array<{ repoDir: string; step: string }>;
  polishClears: string[];
  recordBaselines: Array<{ repoDir: string; branch: string; sha: string }>;
  reopens: string[];
  sliceSources: string[];
  briefs: Array<{ repoDir: string; fromStep: string; text: string }>;
  briefClears: string[];
  assembles: string[];
  pushes: string[];
  order: string[];
}

export function mkDeps(over: Partial<AppGateDecisionDeps> & { run?: AppLoopRunState | null; gate?: GateOptionDef[]; sideEffectThrows?: string; sideEffectNoTarget?: string; commitThrows?: string; commitOutcome?: 'committed' | 'nothing-to-commit'; pr?: number | null; ticket?: number | null; bootstrap?: AppLoopBootstrap | null; pushThrows?: () => string | undefined; holds?: boolean }): {
  deps: AppGateDecisionDeps;
  rec: Recorder;
} {
  const rec: Recorder = { sideEffects: [], commitSideEffects: [], accepts: [], advances: [], audits: [], errors: [], notices: [], views: 0, feedbacks: [], redos: [], polishEnters: [], polishClears: [], recordBaselines: [], reopens: [], sliceSources: [], briefs: [], briefClears: [], assembles: [], pushes: [], order: [] };
  const deps: AppGateDecisionDeps = {
    readRunState: () => (over.run === undefined ? GATE_RUN : over.run),
    resolveDef: () => ({ ok: true, def: defWithGate(over.gate ?? APPROVE_MARK_READY), tierRoot: '/tmp/tier', defDir: '/tmp/tier/loop' }),
    refs: () => ({
      pr: over.pr ?? 41,
      ticket: over.ticket ?? null,
      bootstrap: over.bootstrap ?? null,
    }),
    assembleReport: (_r, report) => {
      rec.assembles.push(report.path);
      rec.order.push('assemble');
    },
    runSideEffect: async (action, ctx) => {
      rec.sideEffects.push({ action, ctx });
      rec.order.push('side-effect');
      if (over.sideEffectThrows) throw new Error(over.sideEffectThrows);
      return over.sideEffectNoTarget === undefined ? { outcome: 'done' } : { outcome: 'no-target', reason: over.sideEffectNoTarget };
    },
    runPushSideEffect: async (branch) => {
      rec.pushes.push(branch);
      rec.order.push('push');
      const reason = over.pushThrows?.();
      if (reason !== undefined) throw new Error(reason);
    },
    failureHoldsGate: () => over.holds ?? false,
    runCommitSideEffect: async (ctx) => {
      rec.commitSideEffects.push(ctx);
      rec.order.push('commit');
      if (over.commitThrows) throw new Error(over.commitThrows);
      return over.commitOutcome === 'nothing-to-commit'
        ? { outcome: 'nothing-to-commit' }
        : { outcome: 'committed', sha: 'a'.repeat(40), branch: 'main' };
    },
    recordBaseline: (repoDir, branch, sha) => void rec.recordBaselines.push({ repoDir, branch, sha }),
    persistAccept: (_r, state) => void rec.accepts.push(state),
    advanceFlow: (r) => void rec.advances.push(r),
    audit: (_r, cmd, exit) => void rec.audits.push({ cmd, exit }),
    emitError: (reason) => void rec.errors.push(reason),
    emitNotice: (reason) => void rec.notices.push(reason),
    onViewChanged: () => void (rec.views += 1),
    deliverFeedback: (_repoDir, step, turnKey, feedback) => {
      rec.feedbacks.push({ step, turnKey, feedback });
      return true;
    },
    deliverRedo: (_repoDir, step, turnKey, instruction) => {
      rec.redos.push({ step, turnKey, instruction });
      return true;
    },
    enterPolish: (repoDir, step) => void rec.polishEnters.push({ repoDir, step }),
    clearPolish: (repoDir) => void rec.polishClears.push(repoDir),
    reopenSlice: (repoDir, reopened) => {
      rec.reopens.push(repoDir);
      rec.order.push('reopen');
      reopened();
      return true;
    },
    recordSliceBrief: (repoDir, fromStep, text) => {
      rec.briefs.push({ repoDir, fromStep, text });
      rec.order.push('brief');
    },
    clearSliceBrief: (repoDir) => {
      rec.briefClears.push(repoDir);
      rec.order.push('clear-brief');
    },
    reopenStep: () => null,
    sourceSliceCount: (repoDir) => void rec.sliceSources.push(repoDir),
    maybeBeginEpicPromotion: () => ({ kind: 'not-epic' }),
    ...over,
  };
  return { deps, rec };
}
