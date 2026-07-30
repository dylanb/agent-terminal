import { describe, expect, it } from 'vitest';
import {
  resolveGateSideEffectBodyFile,
  runAppGateDecision,
  type AppGateDecisionDeps,
} from '../../src/main/appGateDecision';
import type { AppLoopRunState } from '../../src/main/appLoopState';
import type { GateOptionDef, LoopDefV2 } from '../../src/main/loopDefV2';
import type { GateDecisionOption } from '../../src/shared/ipc';

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

const defWithGate = (gate: GateOptionDef[]): LoopDefV2 => ({ gate, outputs: [] } as unknown as LoopDefV2);
const APPROVE_MARK_READY: GateOptionDef[] = [{ option: 'approve', sideEffects: [{ kind: 'gh', args: { action: 'mark-ready' } }] }];

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
  accepts: AppLoopRunState[];
  advances: string[];
  audits: Array<{ cmd: string; exit: number | null }>;
  errors: string[];
  views: number;
  feedbacks: Array<{ step: string; turnKey: string; feedback: string }>;
  redos: Array<{ step: string; turnKey: string; instruction: string }>;
  polishEnters: Array<{ repoDir: string; step: string }>;
  polishClears: string[];
}

function mkDeps(over: Partial<AppGateDecisionDeps> & { run?: AppLoopRunState | null; gate?: GateOptionDef[]; sideEffectThrows?: string; pr?: number | null; ticket?: number | null }): {
  deps: AppGateDecisionDeps;
  rec: Recorder;
} {
  const rec: Recorder = { sideEffects: [], accepts: [], advances: [], audits: [], errors: [], views: 0, feedbacks: [], redos: [], polishEnters: [], polishClears: [] };
  const deps: AppGateDecisionDeps = {
    readRunState: () => (over.run === undefined ? GATE_RUN : over.run),
    resolveDef: () => ({ ok: true, def: defWithGate(over.gate ?? APPROVE_MARK_READY) }),
    refs: () => ({
      pr: over.pr ?? 41,
      ticket: over.ticket ?? null,
      bootstrap: null,
    }),
    runSideEffect: async (action, ctx) => {
      rec.sideEffects.push({ action, ctx });
      if (over.sideEffectThrows) throw new Error(over.sideEffectThrows);
    },
    persistAccept: (_r, state) => void rec.accepts.push(state),
    advanceFlow: (r) => void rec.advances.push(r),
    audit: (_r, cmd, exit) => void rec.audits.push({ cmd, exit }),
    emitError: (reason) => void rec.errors.push(reason),
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
    expect(rec.audits.some((a) => a.cmd.includes('approve') && a.exit === 0)).toBe(true);
    expect(rec.errors).toEqual([]);
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
