import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveGateSideEffectBodyFile,
  runAppApprove,
  runAppGateDecision,
  stepScopedAdvance,
  type AppGateDecisionDeps,
  type ApproveDecider,
} from '../../src/main/appGateDecision';
import { gateDecisionAuditCmd } from '../../src/shared/audit';
import type { AppLoopRunState } from '../../src/main/appLoopState';
import type { GateOptionDef, LoopDefV2 } from '../../src/main/loopDefV2';
import type { FlowStateView, GateDecisionOption } from '../../src/shared/ipc';
import { createEpicPromotionCoordinator } from '../../src/main/epicPromotion';
import { createFlowManager } from '../../src/main/flow';
import { createWorktreeFixture } from '../helpers/worktreeFixture';
import type { AppGateCommitCtx } from '../../src/main/appGateCommit';

// §27.9/§27.13 / N5 — the §27 human-gate decision executor, driven with FAKES (no PTY). Approve runs the
// bound def's declared side-effect out of band, then reaches the terminal accept and advances the flow; a
// failed side-effect is surfaced + audited but never aborts the accept (AC3). It acts only on the step+turn
// identity the decision names (AC7) and only when the run is AT the gate, and validates the option against the
// bound def at the operation (AC9). It never writes retired-engine state — its persist port is the §27 writer (AC8).

const GATE_RUN: AppLoopRunState = {
  loop: 'plan-loop',
  step: 'plan',
  turnKey: 'consolidate-plan',
  status: 'complete',
  round: 2,
  verdict: 'clean',
};

const defWithGate = (gate: GateOptionDef[]): LoopDefV2 => ({ gate, outputs: [], work: { recipe: '/r', artifact: 'commits' } } as unknown as LoopDefV2);
const APPROVE_MARK_READY: GateOptionDef[] = [{ option: 'approve', sideEffects: [{ kind: 'gh', args: { action: 'mark-ready' } }] }];
const APPROVE_COMMIT = (label: unknown): GateOptionDef[] => [{ option: 'approve', sideEffects: [{ kind: 'commit', args: label === undefined ? {} : { label } }] }];

describe('resolveGateSideEffectBodyFile', () => {
  it('resolves only the binding explicitly named by the declared side-effect', () => {
    const def = {
      inputs: [
        {
          id: 'plan',
          path: '/repo/.agent-terminal/loop/artifacts/plan.md',
          rel: '.agent-terminal/loop/artifacts/plan.md',
        },
      ],
      outputs: [],
    } as unknown as LoopDefV2;
    expect(
      resolveGateSideEffectBodyFile(def, {
        kind: 'gh',
        args: { action: 'publish-pr-body', artifact: 'plan' },
      }),
    ).toBe('/repo/.agent-terminal/loop/artifacts/plan.md');
    expect(
      resolveGateSideEffectBodyFile(def, {
        kind: 'gh',
        args: { action: 'publish-pr-body', artifact: 'missing' },
      }),
    ).toBeNull();
  });
});

interface Recorder {
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
  order: string[];
}

function mkDeps(over: Partial<AppGateDecisionDeps> & { run?: AppLoopRunState | null; gate?: GateOptionDef[]; sideEffectThrows?: string; commitThrows?: string; commitOutcome?: 'committed' | 'nothing-to-commit'; pr?: number | null; ticket?: number | null }): {
  deps: AppGateDecisionDeps;
  rec: Recorder;
} {
  const rec: Recorder = { sideEffects: [], commitSideEffects: [], accepts: [], advances: [], audits: [], errors: [], notices: [], views: 0, feedbacks: [], redos: [], polishEnters: [], polishClears: [], recordBaselines: [], reopens: [], sliceSources: [], briefs: [], briefClears: [], order: [] };
  const deps: AppGateDecisionDeps = {
    readRunState: () => (over.run === undefined ? GATE_RUN : over.run),
    resolveDef: () => ({ ok: true, def: defWithGate(over.gate ?? APPROVE_MARK_READY), tierRoot: '/tmp/tier' }),
    refs: () => ({
      pr: over.pr ?? 41,
      ticket: over.ticket ?? null,
      bootstrap: null,
    }),
    runSideEffect: async (action, ctx) => {
      rec.sideEffects.push({ action, ctx });
      if (over.sideEffectThrows) throw new Error(over.sideEffectThrows);
    },
    runCommitSideEffect: async (ctx) => {
      rec.commitSideEffects.push(ctx);
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
    reopenSlice: (repoDir) => {
      rec.reopens.push(repoDir);
      rec.order.push('reopen');
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
    sourceSliceCount: (repoDir) => void rec.sliceSources.push(repoDir),
    maybeBeginEpicPromotion: () => ({ kind: 'not-epic' }),
    ...over,
  };
  return { deps, rec };
}

const approve = (deps: AppGateDecisionDeps, step = 'plan', turnKey = 'consolidate-plan', option: GateDecisionOption = 'approve'): Promise<boolean> =>
  runAppGateDecision('/repo', step, turnKey, option, deps);

const decide = (deps: AppGateDecisionDeps, option: GateDecisionOption, note?: string, step = 'plan', turnKey = 'consolidate-plan'): Promise<boolean> =>
  runAppGateDecision('/repo', step, turnKey, option, deps, note);

describe('runAppGateDecision — approve (§27.13 / AC2)', () => {
  it('runs the declared side-effect, persists the terminal accept, and advances the flow', async () => {
    const { deps, rec } = mkDeps({});
    await approve(deps);
    expect(rec.sideEffects).toEqual([{ action: 'mark-ready', ctx: { pr: 41, ticket: null, bodyFile: null, bootstrap: null } }]);
    expect(rec.accepts).toEqual([{ loop: 'plan-loop', step: 'plan', turnKey: 'consolidate-plan', status: 'accepted' }]);
    expect(rec.advances).toEqual(['/repo']);
    expect(rec.audits.some((a) => a.cmd.includes('mark-ready') && a.exit === 0)).toBe(true);
  });

  it('§28.4.1 — sources the impl-slice count into the flow on approve, never on a non-approve decision', async () => {
    const { deps, rec } = mkDeps({});
    await approve(deps);
    expect(rec.sliceSources).toEqual(['/repo']); // sourced once, on the approve path (before advancing)
    // redo jumps back without accepting/advancing → the count is not sourced
    const { deps: d2, rec: r2 } = mkDeps({});
    await decide(d2, 'redo', 'try again');
    expect(r2.sliceSources).toEqual([]);
    expect(rec.audits.some((a) => a.cmd.includes('approve') && a.exit === 0)).toBe(true);
    expect(rec.errors).toEqual([]);
  });

  // §28.4.1 (CWE-703/755) — sourcing the slice count is best-effort, the same discipline IT-DECISION-3 pins for a
  // throwing baseline store: a throw is recorded on its OWN distinct `source-slices-failed` audit at exit 1 (§25
  // audit-truth) and the approve STILL advances — the count safely degrades to 1 (a single-slice run), so it is
  // never surfaced as a blocking error over a landed approve.
  it('§28.4.1 — a throwing slice-count sourcing is audited distinctly and never aborts the advance', async () => {
    const { deps, rec } = mkDeps({
      sourceSliceCount: () => {
        throw new Error('EACCES: plan.md unreadable');
      },
    });
    await approve(deps);
    expect(rec.audits.some((a) => a.cmd.includes('source-slices failed') && a.exit === 1)).toBe(true);
    expect(rec.advances).toEqual(['/repo']); // best-effort — the accept persisted and the flow advanced regardless
    expect(rec.accepts).toHaveLength(1);
    expect(rec.errors).toEqual([]); // not a blocking error over a successful approve
  });

  it('advances even when the approve declares no side-effect (approve is terminal regardless)', async () => {
    const { deps, rec } = mkDeps({ gate: [{ option: 'approve', sideEffects: [] }] });
    await approve(deps);
    expect(rec.sideEffects).toEqual([]);
    expect(rec.accepts).toHaveLength(1);
    expect(rec.advances).toEqual(['/repo']);
  });

  it('skips a non-gh side-effect yet still accepts and advances (only gh actions run)', async () => {
    const { deps, rec } = mkDeps({ gate: [{ option: 'approve', sideEffects: [{ kind: 'slack', args: { action: 'post' } }] }] });
    await approve(deps);
    expect(rec.sideEffects).toEqual([]); // the non-gh side-effect never reached the gh runner
    expect(rec.commitSideEffects).toEqual([]); // nor the commit runner — an unknown kind routes to neither
    expect(rec.accepts).toHaveLength(1);
    expect(rec.advances).toEqual(['/repo']);
  });
});

describe('runAppGateDecision — a failed side-effect never strands the flow (§27.13 / AC3)', () => {
  it('surfaces + audits the failure but still persists the accept and advances', async () => {
    const { deps, rec } = mkDeps({ sideEffectThrows: 'no PR to mark ready' });
    await approve(deps);
    expect(rec.errors).toHaveLength(1); // exactly one failure surfaced to the operator
    expect(rec.errors[0]).toMatch(/side-effect failed: no PR/); // carrying the underlying cause, not exact copy
    expect(rec.audits.some((a) => a.cmd.includes('side-effect failed') && a.exit === 1)).toBe(true); // recorded
    expect(rec.accepts).toHaveLength(1); // accept NOT aborted
    expect(rec.advances).toEqual(['/repo']); // the flow still advances — a visible next action
  });
});

describe('runAppGateDecision — the commit side-effect (§28.3)', () => {
  it('fires the commit port with the descriptor label, audits it at exit 0, accepts, and advances (T10)', async () => {
    const { deps, rec } = mkDeps({ gate: APPROVE_COMMIT('RED: slice-x') });
    await approve(deps);
    // STD-identity — the label is sourced from se.args, not run-state/branch
    expect(rec.commitSideEffects).toEqual([{ label: 'RED: slice-x', dirtyAtPhaseStart: [] }]);
    // the audit trail names WHICH commit, at exit 0 (a success, not a failure)
    expect(rec.audits.some((a) => a.cmd.includes('side-effect') && a.cmd.includes('RED: slice-x') && a.exit === 0)).toBe(true);
    expect(rec.accepts).toHaveLength(1);
    expect(rec.advances).toEqual(['/repo']);
    expect(rec.errors).toEqual([]);
  });

  it('surfaces + audits a real commit failure at exit 1 but still accepts and advances (T11a, STD-besteffort)', async () => {
    const { deps, rec } = mkDeps({ gate: APPROVE_COMMIT('GREEN: slice-y'), commitThrows: 'git commit failed' });
    await approve(deps);
    expect(rec.errors).toHaveLength(1);
    expect(rec.errors[0]).toMatch(/side-effect failed: git commit failed/);
    expect(rec.notices).toEqual([]); // a real failure is an error, never a benign notice (channel isolation)
    expect(rec.audits.some((a) => a.cmd.includes('side-effect failed') && a.exit === 1)).toBe(true);
    expect(rec.accepts).toHaveLength(1);
    expect(rec.advances).toEqual(['/repo']);
  });

  it('surfaces a benign nothing-to-commit as a live NOTICE (not an error) and still advances (T11b, AC3)', async () => {
    const { deps, rec } = mkDeps({ gate: APPROVE_COMMIT('refactor: slice-z'), commitOutcome: 'nothing-to-commit' });
    await approve(deps);
    // machine-distinct in the audit (decision B) — skipped at exit 0, never the failed token
    expect(rec.audits.some((a) => a.cmd.includes('side-effect skipped') && a.exit === 0)).toBe(true);
    expect(rec.audits.some((a) => a.cmd.includes('side-effect failed'))).toBe(false);
    // AC3 — surfaced LIVE as a NOTICE (not the error channel), naming the condition, never reading as a failure
    expect(rec.notices).toHaveLength(1);
    expect(rec.notices[0]).toMatch(/nothing to commit/i);
    expect(rec.notices[0]).not.toMatch(/fail/i);
    expect(rec.errors).toEqual([]); // a benign no-op is NOT surfaced as an error
    // the notice never blocks completion — the accept persisted and the flow advanced
    expect(rec.accepts).toHaveLength(1);
    expect(rec.advances).toEqual(['/repo']);
  });

  it('sources the label verbatim from se.args, passing empty when the descriptor declares none (T12, STD-identity)', async () => {
    const { deps, rec } = mkDeps({ gate: APPROVE_COMMIT(undefined) });
    await approve(deps);
    expect(rec.commitSideEffects).toEqual([{ label: '', dirtyAtPhaseStart: [] }]); // the executor never invents a label from ambient state
    expect(rec.advances).toEqual(['/repo']);
  });

  it('IT-DECISION-1: records the baseline (repoDir, decision step, EXACT sha) on a committed approve (§28.5.1)', async () => {
    const { deps, rec } = mkDeps({ gate: APPROVE_COMMIT('RED: slice-x') });
    await approve(deps);
    // §6 identity — the recorded sha is exactly the one the side-effect returned, under the decision's own step,
    // never re-derived from ambient git state.
    expect(rec.recordBaselines).toEqual([{ repoDir: '/repo', branch: 'main', sha: 'a'.repeat(40) }]);
    expect(rec.audits.some((a) => a.cmd.includes('side-effect') && a.exit === 0)).toBe(true); // committed audit unchanged
  });

  it('IT-DECISION-2: records NO baseline on nothing-to-commit (nothing committed to diff from); the notice still fires', async () => {
    const { deps, rec } = mkDeps({ gate: APPROVE_COMMIT('refactor: noop'), commitOutcome: 'nothing-to-commit' });
    await approve(deps);
    expect(rec.recordBaselines).toEqual([]);
    expect(rec.notices).toHaveLength(1); // the S2 nothing-to-commit notice is unchanged
  });

  it('IT-DECISION-3: a throwing baseline store never mis-attributes the LANDED commit as a failed side-effect — the commit is still audited committed, the failure surfaces as its OWN distinct baseline-record-failed audit + a live notice (never emitError), and the accept still advances (best-effort, §28.5.1/§27.13)', async () => {
    const { deps, rec } = mkDeps({
      gate: APPROVE_COMMIT('RED: baseline blows up'),
      // the raw disjoint-file store's fail-loud contract — the executor (not the composition root) wraps it.
      recordBaseline: () => {
        throw new Error('§27 loop area is unresolvable');
      },
    });
    await approve(deps);
    // the commit LANDED — its success audit fires at exit 0 and is NEVER re-attributed to "side-effect failed".
    expect(rec.audits.some((a) => a.cmd.includes('side-effect:') && a.exit === 0)).toBe(true);
    expect(rec.audits.some((a) => a.cmd.includes('side-effect failed'))).toBe(false);
    // the baseline failure is recorded on its OWN distinct audit outcome at exit 1 (never swallowed, §25).
    expect(rec.audits.some((a) => a.cmd.includes('clear-polish failed'))).toBe(false);
    expect(rec.audits.some((a) => a.cmd.includes('baseline') && a.exit === 1)).toBe(true);
    // surfaced LIVE as a NOTICE (the accept succeeded — a blocking error would alarm over a landed commit),
    // naming the degraded state so the operator learns to re-run this phase before the next frozen check.
    expect(rec.notices.some((n) => /baseline/i.test(n))).toBe(true);
    expect(rec.errors).toEqual([]);
    // best-effort — the accept persisted and the flow advanced regardless (§27.13/AC3).
    expect(rec.accepts).toHaveLength(1);
    expect(rec.advances).toEqual(['/repo']);
  });

  it('IT-DECISION-4: records NO baseline when the commit side-effect throws (the S2 failure path is unchanged)', async () => {
    const { deps, rec } = mkDeps({ gate: APPROVE_COMMIT('RED: fails'), commitThrows: 'git commit failed' });
    await approve(deps);
    expect(rec.recordBaselines).toEqual([]);
    expect(rec.errors).toHaveLength(1); // surfaced as a side-effect-failed error, no baseline
  });
});

describe('runAppGateDecision — an unpersisted accept never advances the flow (§27.13 / AC3, D48)', () => {
  it('surfaces + audits the persist failure and runs no side-effect and no advance', async () => {
    const { deps, rec } = mkDeps({
      persistAccept: () => {
        throw new Error('ENOSPC: no space left on device');
      },
    });
    await approve(deps);
    expect(rec.errors.some((e) => e.includes('ENOSPC'))).toBe(true); // surfaced, not swallowed
    expect(rec.audits.some((a) => a.cmd.includes('accept failed') && a.exit === 1)).toBe(true); // recorded
    expect(rec.accepts).toEqual([]); // the accept did not persist
    expect(rec.sideEffects).toEqual([]); // the gh side-effect never fired (no double-execution on retry)
    expect(rec.advances).toEqual([]); // the flow did NOT advance over the unpersisted accept
    expect(rec.views).toBeGreaterThanOrEqual(1); // the error path re-renders the gate pane so the failed Approve is visible
  });
});

describe('runAppGateDecision — acts only on the named identity (§6/AC7)', () => {
  it('is inert for a decision naming a different step', async () => {
    const { deps, rec } = mkDeps({});
    await approve(deps, 'implement', 'consolidate-plan');
    expect(rec.sideEffects).toEqual([]);
    expect(rec.accepts).toEqual([]);
    expect(rec.advances).toEqual([]);
  });

  it('is inert for a decision naming a different turn', async () => {
    const { deps, rec } = mkDeps({});
    await approve(deps, 'plan', 'consolidate-implement');
    expect(rec.advances).toEqual([]);
  });

  it('is inert when the run is not AT a gate (no verdict reached)', async () => {
    const { deps, rec } = mkDeps({ run: { loop: 'plan-loop', step: 'plan', turnKey: 'work-plan', status: 'working' } });
    await approve(deps, 'plan', 'work-plan');
    expect(rec.advances).toEqual([]);
    expect(rec.accepts).toEqual([]);
  });

  it('is inert when a second approve races a run already accepted (idempotent, no double-advance)', async () => {
    const { deps, rec } = mkDeps({ run: { loop: 'plan-loop', step: 'plan', turnKey: 'consolidate-plan', status: 'accepted' } });
    await approve(deps);
    expect(rec.advances).toEqual([]);
  });
});

describe('runAppGateDecision — validates the option against the bound def (AC9)', () => {
  it('is inert for an option the bound def does not declare', async () => {
    // The narrowed §27 def declares only approve; request-changes is rejected AT THE OPERATION, not the type.
    const { deps, rec } = mkDeps({});
    await approve(deps, 'plan', 'consolidate-plan', 'request-changes');
    expect(rec.sideEffects).toEqual([]);
    expect(rec.advances).toEqual([]);
  });

  it('is inert for a DECLARED option §27 does not execute — impasse is a retired-engine-only concept', async () => {
    // impasse is never a §27 option. A def declaring it still gets no §27 execution for it — the executor runs
    // only approve, request-changes, redo, and polish.
    const gate: GateOptionDef[] = [
      { option: 'approve', sideEffects: [] },
      { option: 'impasse', sideEffects: [] },
    ];
    const { deps, rec } = mkDeps({ gate });
    await decide(deps, 'impasse');
    expect(rec.sideEffects).toEqual([]);
    expect(rec.accepts).toEqual([]);
    expect(rec.advances).toEqual([]);
    expect(rec.feedbacks).toEqual([]);
    expect(rec.redos).toEqual([]);
    expect(rec.polishEnters).toEqual([]);
  });
});

// §27.9/§19.4 / N5 (AC4) — request-changes delivers the operator's feedback into the next review-and-fix round.
// It is NOT approve: no accept, no gh side-effect, no flow advance — the loop returns to iterate, not off the
// step. The engine's re-enter-review is a domain port (deliverFeedback); the executor validates the identity,
// the at-gate precondition, and the option-against-the-def exactly as approve does.
describe('runAppGateDecision — request-changes delivers feedback into the next round (AC4)', () => {
  const RC_GATE: GateOptionDef[] = [
    { option: 'approve', sideEffects: [{ kind: 'gh', args: { action: 'mark-ready' } }] },
    { option: 'request-changes', sideEffects: [] },
  ];

  it('delivers the typed feedback, reports success, and neither accepts, runs a side-effect, nor advances', async () => {
    const { deps, rec } = mkDeps({ gate: RC_GATE });
    const delivered = await decide(deps, 'request-changes', 'Tighten the migration section.');
    expect(delivered).toBe(true); // the caller (composer) closes only on a confirmed round
    expect(rec.feedbacks).toEqual([{ step: 'plan', turnKey: 'consolidate-plan', feedback: 'Tighten the migration section.' }]);
    expect(rec.accepts).toEqual([]); // request-changes is not terminal — no accept
    expect(rec.sideEffects).toEqual([]); // no gh side-effect (that is approve's)
    expect(rec.advances).toEqual([]); // the flow does not advance off the step — the loop iterates
    expect(rec.audits.some((a) => a.cmd.includes('request-changes') && a.exit === 0)).toBe(true);
  });

  it('reports a DROPPED request-changes as false and audits the drop instead of claiming success', async () => {
    // If the engine drops the re-entry (the runner is mid-turn, or the gate raced out from under the click) the
    // decision returns false so the composer stays open with the operator's feedback intact — the human never
    // silently loses what they typed. The §25 audit records the drop (exit 1), never a lie (exit 0 for a round
    // that never ran). Surfacing is the caller's job now (the composer), so no toast/view-refresh is fired here.
    const { deps, rec } = mkDeps({ gate: RC_GATE, deliverFeedback: () => false });
    const delivered = await decide(deps, 'request-changes', 'Tighten the migration section.');
    expect(delivered).toBe(false); // the composer reads this to stay open + preserve the feedback
    expect(rec.audits.some((a) => a.cmd.includes('request-changes') && a.exit === 0)).toBe(false); // no false success
    expect(rec.audits.some((a) => a.cmd.includes('request-changes') && a.exit === 1)).toBe(true); // recorded as a drop
    expect(rec.errors).toEqual([]); // the executor no longer double-surfaces — the composer owns the message
  });

  it('is inert when the bound def does not declare request-changes (validated at the operation, AC9)', async () => {
    // The approve-only def (the mkDeps default) declares no request-changes; the option is rejected AT THE
    // operation, not the wire type (which admits it).
    const { deps, rec } = mkDeps({});
    await decide(deps, 'request-changes', 'do the thing');
    expect(rec.feedbacks).toEqual([]);
  });

  it('is inert with blank/whitespace feedback — request-changes needs the human to type feedback (§27.9)', async () => {
    const { deps, rec } = mkDeps({ gate: RC_GATE });
    await decide(deps, 'request-changes', '   \n ');
    expect(rec.feedbacks).toEqual([]); // no meaningless empty round is fired
    expect(rec.advances).toEqual([]);
  });

  it('is inert for a decision naming a different step (§6/AC7)', async () => {
    const { deps, rec } = mkDeps({ gate: RC_GATE });
    await decide(deps, 'request-changes', 'valid feedback', 'implement', 'consolidate-plan');
    expect(rec.feedbacks).toEqual([]);
  });

  it('is inert when the run is not AT a gate (no verdict reached)', async () => {
    const { deps, rec } = mkDeps({ gate: RC_GATE, run: { loop: 'plan-loop', step: 'plan', turnKey: 'review-plan', status: 'working' } });
    await decide(deps, 'request-changes', 'valid feedback', 'plan', 'review-plan');
    expect(rec.feedbacks).toEqual([]);
  });
});

// §27.9 / N5 (AC5) — redo re-enters the WORK turn on a clean slate carrying the operator's instruction. Like
// request-changes it is two-way (the redo composer holds open on a drop) and neither accepts, runs a side-effect,
// nor advances. The engine's clean-slate re-entry is a domain port (deliverRedo); the executor validates the
// identity, the at-gate precondition, and the option-against-the-def exactly as request-changes does.
describe('runAppGateDecision — redo re-enters the work turn carrying the instruction (AC5)', () => {
  const REDO_GATE: GateOptionDef[] = [
    { option: 'approve', sideEffects: [{ kind: 'gh', args: { action: 'mark-ready' } }] },
    { option: 'redo', sideEffects: [] },
  ];

  it('delivers the typed instruction, reports success, and neither accepts, runs a side-effect, nor advances', async () => {
    const { deps, rec } = mkDeps({ gate: REDO_GATE });
    const delivered = await decide(deps, 'redo', 'Start over; the plan structure is wrong.');
    expect(delivered).toBe(true); // the redo composer closes only on a confirmed re-entry
    expect(rec.redos).toEqual([{ step: 'plan', turnKey: 'consolidate-plan', instruction: 'Start over; the plan structure is wrong.' }]);
    expect(rec.accepts).toEqual([]); // redo is not terminal — no accept
    expect(rec.sideEffects).toEqual([]); // no gh side-effect (that is approve's)
    expect(rec.advances).toEqual([]); // the flow does not advance off the step — the work turn re-runs
    expect(rec.audits.some((a) => a.cmd.includes('redo') && a.exit === 0)).toBe(true);
  });

  it('reports a DROPPED redo as false and audits the drop instead of claiming success', async () => {
    const { deps, rec } = mkDeps({ gate: REDO_GATE, deliverRedo: () => false });
    const delivered = await decide(deps, 'redo', 'Start over.');
    expect(delivered).toBe(false); // the composer reads this to stay open + preserve the instruction
    expect(rec.audits.some((a) => a.cmd.includes('redo') && a.exit === 0)).toBe(false); // no false success
    expect(rec.audits.some((a) => a.cmd.includes('redo') && a.exit === 1)).toBe(true); // recorded as a drop
    expect(rec.errors).toEqual([]); // the composer owns the message — no double-surface
  });

  it('is inert with blank/whitespace instruction — redo needs the human to type an instruction (§27.9)', async () => {
    const { deps, rec } = mkDeps({ gate: REDO_GATE });
    await decide(deps, 'redo', '   \n ');
    expect(rec.redos).toEqual([]);
    expect(rec.advances).toEqual([]);
  });

  it('is inert when the bound def does not declare redo (validated at the operation, AC9)', async () => {
    const { deps, rec } = mkDeps({}); // approve-only default def
    await decide(deps, 'redo', 'do the thing');
    expect(rec.redos).toEqual([]);
  });
});

// §28.4.2 — back-to-red is the human counterpart to §28.4.1's automatic loop-back: it re-enters the current
// slice's RED step (reopenSlice) so the operator can redo missed work. Like redo/polish it is NOT approve — no
// accept, no gh side-effect, no advance — and one-way (no note to lose). It is validated against the bound def
// at the operation (AC9) and acts only on the named step+turn identity (§6/AC7).
describe('runAppGateDecision — back-to-red reopens the current slice (§28.4.2)', () => {
  const BACK_TO_RED_GATE: GateOptionDef[] = [
    { option: 'approve', sideEffects: [{ kind: 'commit', args: { label: 'GREEN' } }] },
    { option: 'back-to-red', sideEffects: [] },
  ];
  const GREEN_RUN: AppLoopRunState = { loop: 'green-loop', step: 'green', turnKey: 'consolidate-green', status: 'complete', round: 1, verdict: 'clean' };
  const atGreen = (deps: AppGateDecisionDeps, option: GateDecisionOption = 'back-to-red'): Promise<boolean> =>
    runAppGateDecision('/repo', 'green', 'consolidate-green', option, deps);

  it('invokes reopenSlice and neither accepts, runs a side-effect, nor advances', async () => {
    const { deps, rec } = mkDeps({ run: GREEN_RUN, gate: BACK_TO_RED_GATE });
    const result = await atGreen(deps);
    expect(result).toBe(true); // the slice reopened
    expect(rec.reopens).toEqual(['/repo']); // the flow jumps back to the slice's RED step
    expect(rec.accepts).toEqual([]); // back-to-red is not terminal — no accept
    expect(rec.sideEffects).toEqual([]); // no gh side-effect (that is approve's)
    expect(rec.commitSideEffects).toEqual([]); // and no commit — the reopen only moves the flow
    expect(rec.advances).toEqual([]); // it goes BACKWARD, never advances off the step
    expect(rec.audits.some((a) => a.cmd.includes('back-to-red') && a.exit === 0)).toBe(true);
    expect(rec.views).toBeGreaterThan(0); // the view refreshes so the operator sees the flow back at RED
  });

  it('is inert when the bound def does not declare back-to-red (validated at the operation, AC9)', async () => {
    const { deps, rec } = mkDeps({ run: GREEN_RUN, gate: [{ option: 'approve', sideEffects: [] }] });
    await atGreen(deps);
    expect(rec.reopens).toEqual([]);
    expect(rec.advances).toEqual([]);
  });

  it('is inert for a decision naming a different step (§6/AC7)', async () => {
    const { deps, rec } = mkDeps({ run: GREEN_RUN, gate: BACK_TO_RED_GATE });
    await runAppGateDecision('/repo', 'refactor', 'consolidate-green', 'back-to-red', deps);
    expect(rec.reopens).toEqual([]);
  });

  // §28.4.2 (CWE-703/755) — reopening the slice is best-effort: a throw from the reopen port (the flow-state
  // write behind flow.reopenSlice cannot land — a symlinked/EACCES `.agent-terminal`, ENOSPC) is surfaced to
  // the operator and the decision resolves without stranding, never rejecting into the one-way void caller.
  // Pairs the happy path above; the sibling polish branch pins the same surfacing for its throwing port.
  it('surfaces a thrown reopen-slice error and resolves without stranding (CWE-703)', async () => {
    const { deps, rec } = mkDeps({
      run: GREEN_RUN,
      gate: BACK_TO_RED_GATE,
      reopenSlice: () => {
        throw new Error('ENOSPC: no space left on device');
      },
    });
    await expect(atGreen(deps)).resolves.toBe(false); // resolves — never rejects into the void caller
    expect(rec.errors.some((e) => e.includes('ENOSPC'))).toBe(true); // the failure is surfaced to the operator
    expect(rec.views).toBeGreaterThan(0); // the view still refreshes so the operator is not left with a stale gate
  });
});

// §28.4.2 — back-to-red carries an optional brief for the reopened slice. It is recorded BEFORE the reopen (the
// reopen re-enters RED, whose prompt reads it) and rolled back if the reopen does not land, so a failed reopen
// never leaves a brief waiting to leak into a later slice. The two-way caller keeps the typed brief on false.
describe('runAppGateDecision — back-to-red with a slice brief (§28.4.2)', () => {
  const GATE: GateOptionDef[] = [
    { option: 'approve', sideEffects: [] },
    { option: 'back-to-red', sideEffects: [] },
  ];
  const RUN: AppLoopRunState = { loop: 'green-loop', step: 'green', turnKey: 'consolidate-green', status: 'complete', round: 1, verdict: 'clean' };
  const backToRed = (deps: AppGateDecisionDeps, brief?: string): Promise<boolean> =>
    runAppGateDecision('/repo', 'green', 'consolidate-green', 'back-to-red', deps, brief);

  it('records the brief with the gate it came from, then reopens the slice', async () => {
    const { deps, rec } = mkDeps({ run: RUN, gate: GATE });
    await expect(backToRed(deps, 'Cover the empty-input case')).resolves.toBe(true);
    expect(rec.briefs).toEqual([{ repoDir: '/repo', fromStep: 'green', text: 'Cover the empty-input case' }]);
    expect(rec.order).toEqual(['brief', 'reopen']);
  });

  it('records no brief for a blank one — a plain reopen', async () => {
    const { deps, rec } = mkDeps({ run: RUN, gate: GATE });
    await expect(backToRed(deps, '   ')).resolves.toBe(true);
    expect(rec.briefs).toEqual([]);
    expect(rec.reopens).toEqual(['/repo']);
  });

  it('rolls the brief back and reports false when the reopen does not move the flow', async () => {
    const { deps, rec } = mkDeps({ run: RUN, gate: GATE, reopenSlice: () => false });
    await expect(backToRed(deps, 'Cover the empty-input case')).resolves.toBe(false);
    expect(rec.briefClears).toEqual(['/repo']);
    expect(rec.errors.length).toBeGreaterThan(0);
  });

  it('rolls the brief back when the reopen throws', async () => {
    const { deps, rec } = mkDeps({
      run: RUN,
      gate: GATE,
      reopenSlice: () => {
        throw new Error('ENOSPC');
      },
    });
    await expect(backToRed(deps, 'Cover the empty-input case')).resolves.toBe(false);
    expect(rec.briefClears).toEqual(['/repo']);
  });

  it('does not reopen when the brief cannot be recorded, so the caller keeps the typed brief', async () => {
    const { deps, rec } = mkDeps({
      run: RUN,
      gate: GATE,
      recordSliceBrief: () => {
        throw new Error('loop area is unresolvable');
      },
    });
    await expect(backToRed(deps, 'Cover the empty-input case')).resolves.toBe(false);
    expect(rec.reopens).toEqual([]);
    expect(rec.errors.some((e) => e.includes('unresolvable'))).toBe(true);
  });
});

// §28.4.2 — the brief lives until the slice ends: approving REFACTOR (the slice's last phase) clears it; approving
// any other loop leaves it for the phases still to come.
describe('runAppGateDecision — approve clears the slice brief only at the end of the slice (§28.4.2)', () => {
  const run = (loop: string, step: string): AppLoopRunState => ({ loop, step, turnKey: `consolidate-${step}`, status: 'complete', round: 1, verdict: 'clean' });
  const withCompletion = (completion: 'red' | 'green' | 'refactor') => ({
    ok: true as const,
    def: { ...defWithGate([{ option: 'approve', sideEffects: [] }]), work: { recipe: '/r', artifact: 'commits', completion } },
    tierRoot: '/tmp/tier',
  });

  it('clears the brief on a refactor approve', async () => {
    const { deps, rec } = mkDeps({ run: run('refactor-loop', 'refactor'), resolveDef: () => withCompletion('refactor') });
    await runAppGateDecision('/repo', 'refactor', 'consolidate-refactor', 'approve', deps);
    expect(rec.briefClears).toEqual(['/repo']);
  });

  it('a failed brief clear on refactor approve is audited and never blocks the advance', async () => {
    const { deps, rec } = mkDeps({
      run: run('refactor-loop', 'refactor'),
      resolveDef: () => withCompletion('refactor'),
      clearSliceBrief: () => {
        throw new Error('EISDIR');
      },
    });
    await runAppGateDecision('/repo', 'refactor', 'consolidate-refactor', 'approve', deps);
    expect(rec.advances).toEqual(['/repo']);
    expect(rec.audits.some((a) => a.cmd.includes('clear-brief failed') && a.cmd.includes('EISDIR') && a.exit === 1)).toBe(true);
  });

  it('keeps the brief on a red or green approve', async () => {
    for (const c of ['red', 'green'] as const) {
      const { deps, rec } = mkDeps({ run: run(`${c}-loop`, c), resolveDef: () => withCompletion(c) });
      await runAppGateDecision('/repo', c, `consolidate-${c}`, 'approve', deps);
      expect(rec.briefClears, c).toEqual([]);
    }
  });
});

// §27.9 / N5 (AC6) — polish stands the orchestrator down: the executor writes app-owned loop state (enterPolish)
// and nothing else — no accept, no side-effect, no advance. Approve ends it (clearPolish) before its accept.
describe('runAppGateDecision — polish stands the orchestrator down (AC6)', () => {
  const POLISH_GATE: GateOptionDef[] = [
    { option: 'approve', sideEffects: [{ kind: 'gh', args: { action: 'mark-ready' } }] },
    { option: 'polish', sideEffects: [] },
  ];

  it('enters the polish stand-down (app-owned state) and neither accepts, runs a side-effect, nor advances', async () => {
    const { deps, rec } = mkDeps({ gate: POLISH_GATE });
    await decide(deps, 'polish');
    expect(rec.polishEnters).toEqual([{ repoDir: '/repo', step: 'plan' }]); // the stand-down for the named step
    expect(rec.accepts).toEqual([]);
    expect(rec.sideEffects).toEqual([]);
    expect(rec.advances).toEqual([]);
    expect(rec.audits.some((a) => a.cmd.includes('polish') && a.exit === 0)).toBe(true);
  });

  it('is inert when the bound def does not declare polish (validated at the operation, AC9)', async () => {
    const { deps, rec } = mkDeps({}); // approve-only default def
    await decide(deps, 'polish');
    expect(rec.polishEnters).toEqual([]);
  });

  it('is inert for a decision naming a different step (§6/AC7)', async () => {
    const { deps, rec } = mkDeps({ gate: POLISH_GATE });
    await decide(deps, 'polish', undefined, 'implement', 'consolidate-plan');
    expect(rec.polishEnters).toEqual([]);
  });

  // §27.9 / N5 (AC6, CWE-703) — entering polish is best-effort: a throw (an unresolvable loop area — a planted
  // symlink) is surfaced to the operator and the decision resolves without stranding, never rejecting into the
  // one-way caller. Pairs the happy path above so the surfacing behavior is pinned, not just the success.
  it('surfaces a thrown enter-polish error and resolves without stranding (AC6)', async () => {
    const { deps, rec } = mkDeps({
      gate: POLISH_GATE,
      enterPolish: () => {
        throw new Error('ENOSPC: no space left on device');
      },
    });
    await expect(decide(deps, 'polish')).resolves.toBe(false); // resolves — never rejects into the void caller
    expect(rec.polishEnters).toEqual([]); // the stand-down write did not land
    expect(rec.errors.some((e) => e.includes('ENOSPC'))).toBe(true); // the failure is surfaced to the operator
    expect(rec.views).toBeGreaterThan(0); // the view still refreshes so the operator is not left with a stale gate
  });
});

// §27.9 / N5 (AC6) — approve ends any active polish stand-down: it clears the polish state, then runs the normal
// terminal accept + side-effect + advance. The clear happens only once the accept has persisted, so a failed
// accept leaves the operator still in polish (able to retry) rather than stranded out of it.
describe('runAppGateDecision — approve ends the polish stand-down (AC6)', () => {
  it('clears the polish stand-down as part of a successful approve, then accepts and advances', async () => {
    const { deps, rec } = mkDeps({});
    await approve(deps);
    expect(rec.polishClears).toEqual(['/repo']); // approve ends polish
    expect(rec.accepts).toHaveLength(1);
    expect(rec.advances).toEqual(['/repo']);
  });

  it('does NOT clear polish when the accept persist fails — the operator stays in polish and can retry', async () => {
    const { deps, rec } = mkDeps({
      persistAccept: () => {
        throw new Error('ENOSPC: no space left on device');
      },
    });
    await approve(deps);
    expect(rec.accepts).toEqual([]); // the accept did not persist
    expect(rec.polishClears).toEqual([]); // …so polish was NOT ended — a retry is still possible from polish
  });

  // §27.9 / N5 (AC6, CWE-703) — clearing polish is a best-effort cleanup on the approve critical path. A throw
  // (e.g. the polish file swapped for a directory across a relaunch → EISDIR, which rmSync's `force` does not
  // swallow) must NOT abort the approve: the accept has already persisted, so aborting here would strand the
  // flow past a persisted accept (PR never published, flow never advanced, re-approve inert). The throw is
  // caught and audited; a residual polish file is harmless (post-accept the gate view never renders).
  it('a thrown clear-polish never aborts the approve — the accept still advances and the side-effect still runs', async () => {
    const { deps, rec } = mkDeps({
      clearPolish: () => {
        throw new Error('EISDIR: illegal operation on a directory');
      },
    });
    await expect(approve(deps)).resolves.toBe(false); // resolves — the throw is caught, never rejects into the void caller
    expect(rec.accepts).toHaveLength(1); // the accept persisted before the (now-caught) clear
    expect(rec.sideEffects).toEqual([{ action: 'mark-ready', ctx: { pr: 41, ticket: null, bodyFile: null, bootstrap: null } }]);
    expect(rec.advances).toEqual(['/repo']); // the flow advanced past the gate — no strand
    expect(rec.errors).toEqual([]); // a best-effort clear failure is audited, not surfaced as a blocking dialog
    expect(rec.audits.some((a) => a.cmd.includes('clear') && a.cmd.includes('polish') && a.exit === 1)).toBe(true);
  });
});

describe('runAppGateDecision — inert when the gate cannot be established', () => {
  it('is inert when the bound def fails to resolve (no accept, side-effect, or advance)', async () => {
    const { deps, rec } = mkDeps({ resolveDef: () => ({ ok: false, reason: 'def failed to parse' }) });
    await approve(deps);
    expect(rec.accepts).toEqual([]);
    expect(rec.sideEffects).toEqual([]);
    expect(rec.advances).toEqual([]);
  });

  it('is inert when no run-state is persisted (null)', async () => {
    const { deps, rec } = mkDeps({ run: null });
    await approve(deps);
    expect(rec.accepts).toEqual([]);
    expect(rec.advances).toEqual([]);
  });
});

// §28.7 — approving an epic-classified plan is classified into an EpicGateOutcome BEFORE the accept.
describe('runAppGateDecision — epic promotion interception (§28.7)', () => {
  // The §25 preview event's cmd, derived from its single producer so a rename re-flows here (shared-semantics).
  const previewAuditCmd = gateDecisionAuditCmd('epic-promotion-preview', 'approve');

  it('preview-raised holds an epic approve before accept: no accept, no advance, no side-effect, preview audited', async () => {
    const { deps, rec } = mkDeps({ maybeBeginEpicPromotion: () => ({ kind: 'preview-raised' }) });
    await approve(deps);
    expect(rec.accepts).toHaveLength(0);
    expect(rec.advances).toHaveLength(0);
    expect(rec.sideEffects).toHaveLength(0); // mark-ready must not fire on an epic (it terminates, not readies)
    expect(rec.views).toBeGreaterThan(0); // the panel re-renders to show the held preview
    expect(rec.audits.some((a) => a.cmd.includes(previewAuditCmd) && a.exit === 0)).toBe(true);
  });

  it('blocked holds an epic approve WITHOUT a preview: no accept, no advance, no side-effect, NO preview audit', async () => {
    const { deps, rec } = mkDeps({ maybeBeginEpicPromotion: () => ({ kind: 'blocked' }) });
    await approve(deps);
    expect(rec.accepts).toHaveLength(0); // held at the gate — not accepted
    expect(rec.advances).toHaveLength(0); // …and not advanced (the RED silent-advance the fix closes)
    expect(rec.sideEffects).toHaveLength(0);
    expect(rec.views).toBeGreaterThan(0); // the panel re-renders (the coordinator already surfaced the error)
    expect(rec.audits.some((a) => a.cmd.includes(previewAuditCmd))).toBe(false); // §25 — NO preview event on a block
    expect(rec.errors).toHaveLength(0); // the blocked branch surfaces no error of its own — the coordinator already did
  });

  it('does not intercept a non-epic approve: the normal accept + advance runs', async () => {
    const { deps, rec } = mkDeps({ maybeBeginEpicPromotion: () => ({ kind: 'not-epic' }) });
    await approve(deps);
    expect(rec.accepts).toHaveLength(1);
    expect(rec.advances).toHaveLength(1);
  });
});

// #137 AC7/AC8 — who decided, at the approve operation: every entry an approve writes, under each decider.
describe('runAppApprove — every approve entry carries its decider (§27.9.1 N9b.9, #137 AC7/AC8)', () => {
  const refactorRun: AppLoopRunState = { loop: 'refactor-loop', step: 'refactor', turnKey: 'consolidate-refactor', status: 'complete', round: 1, verdict: 'clean' };
  const refactorDef = { ok: true as const, def: { ...defWithGate([{ option: 'approve', sideEffects: [] }]), work: { recipe: '/r', artifact: 'commits', completion: 'refactor' as const } }, tierRoot: '/tmp/tier' };
  const throwing = (message: string) => () => {
    throw new Error(message);
  };
  // Pinning: each scenario's human entries as written at 8f03f066.
  const SCENARIOS: [string, Parameters<typeof mkDeps>[0], [string, number][]][] = [
    ['a gh side-effect that runs', {}, [['§27 gate approve side-effect: mark-ready', 0], ['§27 gate approve', 0]]],
    ['a commit with nothing to commit', { gate: APPROVE_COMMIT('RED'), commitOutcome: 'nothing-to-commit' }, [['§27 gate approve side-effect skipped: commit: nothing to commit', 0], ['§27 gate approve', 0]]],
    ['a gh side-effect that fails', { sideEffectThrows: 'no PR to mark ready' }, [['§27 gate approve side-effect failed: mark-ready: no PR to mark ready', 1], ['§27 gate approve', 0]]],
    ['an accept that fails to persist', { persistAccept: throwing('ENOSPC') }, [['§27 gate approve accept failed: ENOSPC', 1]]],
    ['a polish clear that fails', { clearPolish: throwing('EISDIR') }, [['§27 gate approve clear-polish failed: EISDIR', 1], ['§27 gate approve side-effect: mark-ready', 0], ['§27 gate approve', 0]]],
    ['a baseline record that fails', { gate: APPROVE_COMMIT('GREEN'), recordBaseline: throwing('EIO') }, [['§27 gate approve side-effect: commit: GREEN', 0], ['§27 gate approve baseline-record failed: EIO', 1], ['§27 gate approve', 0]]],
    ['a slice-count sourcing that fails', { sourceSliceCount: throwing('EACCES') }, [['§27 gate approve side-effect: mark-ready', 0], ['§28 gate approve source-slices failed: EACCES', 1], ['§27 gate approve', 0]]],
    ['a slice-brief clear that fails', { run: refactorRun, resolveDef: () => refactorDef, clearSliceBrief: throwing('ENOENT') }, [['§28 gate approve clear-brief failed: ENOENT', 1], ['§27 gate approve', 0]]],
    ['an epic preview', { maybeBeginEpicPromotion: () => ({ kind: 'preview-raised' }) }, [['§28 gate approve epic-promotion preview raised', 0]]],
  ];
  const entries = (rec: Recorder): [string, number | null][] => rec.audits.map((a) => [a.cmd, a.exit]);
  const engineDecider = (loop: string): ApproveDecider => ({ kind: 'engine', boundLoop: loop, humanAttempted: () => false, claimAccept: () => ({ ok: true }), checkDef: () => null });

  it.each(SCENARIOS)('pinning: a human approve with %s writes its pre-#137 entries', async (_name, over, literals) => {
    const { deps, rec } = mkDeps(over);
    const run = deps.readRunState('/repo')!;
    await runAppGateDecision('/repo', run.step, run.turnKey, 'approve', deps);
    expect(entries(rec)).toEqual(literals);
  });

  it.each(SCENARIOS)('a human-decided runAppApprove with %s writes exactly the human entries', async (_name, over, literals) => {
    const { deps, rec } = mkDeps(over);
    const run = deps.readRunState('/repo')!;
    await runAppApprove('/repo', run.step, run.turnKey, deps, { kind: 'human' });
    expect(entries(rec)).toEqual(literals);
  });

  it.each(SCENARIOS)('an engine-decided runAppApprove with %s marks every entry it writes', async (_name, over, literals) => {
    const { deps, rec } = mkDeps(over);
    const run = deps.readRunState('/repo')!;
    await runAppApprove('/repo', run.step, run.turnKey, deps, engineDecider(run.loop));
    expect(entries(rec)).toEqual(literals.map(([cmd, exit]) => [cmd.replace(/^(§2[78] gate approve)/, '$1 (engine-decided)'), exit]));
  });

  // Concrete choice 1 — the outcome the engine branches on (N9b.5(c)/(d)).
  const OUTCOMES: Record<string, unknown> = {
    'a gh side-effect that runs': { kind: 'advanced', effectFailures: [] },
    'a commit with nothing to commit': { kind: 'advanced', effectFailures: [] },
    'a gh side-effect that fails': { kind: 'advanced', effectFailures: [expect.stringContaining('no PR to mark ready')] },
    'an accept that fails to persist': { kind: 'accept-failed', reason: expect.stringContaining('ENOSPC') },
    'a polish clear that fails': { kind: 'advanced', effectFailures: [expect.stringContaining('EISDIR')] },
    'a baseline record that fails': { kind: 'advanced', effectFailures: [expect.stringContaining('EIO')] },
    'a slice-count sourcing that fails': { kind: 'advanced', effectFailures: [expect.stringContaining('EACCES')] },
    'a slice-brief clear that fails': { kind: 'advanced', effectFailures: [expect.stringContaining('ENOENT')] },
    'an epic preview': { kind: 'preview-raised' },
  };

  it.each(SCENARIOS)('an engine-decided runAppApprove with %s returns the outcome naming what happened', async (name, over) => {
    const { deps } = mkDeps(over);
    const run = deps.readRunState('/repo')!;
    await expect(runAppApprove('/repo', run.step, run.turnKey, deps, engineDecider(run.loop))).resolves.toEqual(OUTCOMES[name]);
  });

  const noEffect = (rec: Recorder): void => {
    expect(rec.accepts).toEqual([]);
    expect(rec.sideEffects).toEqual([]);
    expect(rec.commitSideEffects).toEqual([]);
    expect(rec.advances).toEqual([]);
    expect(rec.audits).toEqual([]);
  };

  it('stands down, with no effect and no entry, when a human attempt reached the gate first', async () => {
    const { deps, rec } = mkDeps({});
    const decider: ApproveDecider = { ...engineDecider('plan-loop'), humanAttempted: () => true } as ApproveDecider;
    await expect(runAppApprove('/repo', 'plan', 'consolidate-plan', deps, decider)).resolves.toEqual({ kind: 'stood-down' });
    noEffect(rec);
  });

  it('refuses, with no effect, when the run-state names a loop other than the Start-bound one', async () => {
    const { deps, rec } = mkDeps({});
    await expect(runAppApprove('/repo', 'plan', 'consolidate-plan', deps, engineDecider('some-other-loop'))).resolves.toEqual({ kind: 'refused', reason: expect.any(String) });
    noEffect(rec);
  });

  it('refuses before any effect when the def check fails', async () => {
    const { deps, rec } = mkDeps({ maybeBeginEpicPromotion: () => ({ kind: 'preview-raised' }) });
    const decider: ApproveDecider = { ...engineDecider('plan-loop'), checkDef: () => 'the def changed since Start' } as ApproveDecider;
    await expect(runAppApprove('/repo', 'plan', 'consolidate-plan', deps, decider)).resolves.toEqual({ kind: 'refused', reason: expect.stringContaining('the def changed since Start') });
    noEffect(rec);
  });

  it.each([
    ['abandoned', { ok: false, abandoned: true }, { kind: 'abandoned' }],
    ['run-ended', { ok: false, runEnded: true }, { kind: 'run-ended' }],
    ['refused-late', { ok: false, reasons: ['c', 'g'] }, { kind: 'refused-late', reasons: ['c', 'g'] }],
  ] as const)('a refused accept claim returns %s and persists nothing', async (_name, claim, outcome) => {
    const { deps, rec } = mkDeps({});
    const decider: ApproveDecider = { ...engineDecider('plan-loop'), claimAccept: () => claim } as ApproveDecider;
    await expect(runAppApprove('/repo', 'plan', 'consolidate-plan', deps, decider)).resolves.toEqual(outcome);
    noEffect(rec);
  });

  it.each([
    ['pinning: a human', '', (): ApproveDecider => ({ kind: 'human' })],
    ['an engine', '(engine-decided) ', (): ApproveDecider => engineDecider('plan-bundle-loop')],
  ] as const)('%s approve reaching a blocked epic promotion through the real coordinator writes the blocked entry with its decider', async (_n, mark, decider) => {
    const coordAudits: Array<{ cmd: string; exit: number | null }> = [];
    const coord = createEpicPromotionCoordinator({
      readSubTickets: () => [{ index: 1, title: 'Slice one', body: 'Acceptance criteria: a\n\nplan one' }],
      promotionRecordBlock: () => null,
      emitPreview: () => undefined,
      runPromotion: () => Promise.resolve(),
      persistAccept: () => undefined,
      terminateFlow: () => ({ outcome: 'reset', view: {} as FlowStateView }),
      audit: (_r, cmd, exit) => void coordAudits.push({ cmd, exit }),
      emitError: () => undefined,
      onViewChanged: () => undefined,
    });
    const bundleRun: AppLoopRunState = { loop: 'plan-bundle-loop', step: 'plan-bundle', turnKey: 'consolidate-plan-bundle', status: 'complete', round: 1, verdict: 'clean' };
    const { deps, rec } = mkDeps({
      run: bundleRun,
      maybeBeginEpicPromotion: (repoDir, def, step, turnKey, d) => coord.maybeBegin(repoDir, def, 'plan-bundle-loop', step, turnKey, { epic: null, pr: 77 }, d),
    });
    await runAppApprove('/repo', 'plan-bundle', 'consolidate-plan-bundle', deps, decider());
    expect(coordAudits).toEqual([{ cmd: `§28 epic-promotion ${mark}blocked — unresolvable epic issue`, exit: 1 }]);
    expect(rec.accepts).toEqual([]);
    expect(rec.advances).toEqual([]);
  });

  it('an engine-decided runAppApprove held by a blocked epic promotion returns blocked', async () => {
    const { deps } = mkDeps({ maybeBeginEpicPromotion: () => ({ kind: 'blocked' }) });
    await expect(runAppApprove('/repo', 'plan', 'consolidate-plan', deps, engineDecider('plan-loop'))).resolves.toEqual({ kind: 'blocked' });
  });
});

// §27.9.1 N9b.5(e) — the approve's advance is scoped to the step it decided: a manual Advance that lands while its
// effects run has already moved the flow on, and the approve must not advance it a second time.
describe('runAppApprove — the advance is step-scoped (#137 S1)', () => {
  const fx = createWorktreeFixture();
  afterEach(() => fx.cleanup());

  it.each([
    ['human', (): ApproveDecider => ({ kind: 'human' })],
    ['engine', (): ApproveDecider => ({ kind: 'engine', boundLoop: 'plan-loop', humanAttempted: () => false, claimAccept: () => ({ ok: true }), checkDef: () => null })],
  ] as const)('the %s approve of step N whose flow a manual Advance moved to N+1 mid-effects ends at N+1, entered once', async (_name, decider) => {
    const wt = fx.makeWorktree('step-scoped-advance');
    fx.writeFlowHome(wt, { name: 'scoped', stepIds: ['plan', 'next', 'after'] });
    const entered: string[] = [];
    const flow = createFlowManager({ globalDir: fx.outsideDir('step-scoped-global'), onEnterStep: (step) => void entered.push(step.id) });
    expect(flow.start(wt).stepName).toBe('plan');
    entered.length = 0;
    const { deps } = mkDeps({
      gate: APPROVE_COMMIT('RED'),
      runCommitSideEffect: async () => {
        flow.advance(wt);
        return { outcome: 'committed', sha: 'a'.repeat(40), branch: 'main' };
      },
      advanceFlow: stepScopedAdvance((repoDir) => flow.state(repoDir).stepName, (repoDir) => void flow.advance(repoDir)),
    });
    await runAppApprove(wt, 'plan', 'consolidate-plan', deps, decider());
    expect(flow.state(wt).stepName).toBe('next');
    expect(entered).toEqual(['next']);
  });
});
