import { describe, expect, it } from 'vitest';
import { runAppGateDecision, type AppGateDecisionDeps } from '../../src/main/appGateDecision';
import type { AppLoopRunState } from '../../src/main/appLoopState';
import type { GateOptionDef, LoopDefV2 } from '../../src/main/loopDefV2';
import type { GateDecisionOption } from '../../src/shared/ipc';

// §27.9/§27.13 / N5 — the §27 human-gate decision executor, driven with FAKES (no PTY). Approve runs the
// bound def's declared side-effect out of band, then reaches the terminal accept and advances the flow; a
// failed side-effect is surfaced + audited but never aborts the accept (AC3). It acts only on the step+turn
// identity the decision names (AC7) and only when the run is AT the gate, and validates the option against the
// bound def at the operation (AC9). It never writes §26 state — its persist port is the §27 writer (AC8).

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

interface Recorder {
  sideEffects: Array<{ action: string; ctx: unknown }>;
  accepts: AppLoopRunState[];
  advances: string[];
  audits: Array<{ cmd: string; exit: number | null }>;
  errors: string[];
  views: number;
}

function mkDeps(over: Partial<AppGateDecisionDeps> & { run?: AppLoopRunState | null; gate?: GateOptionDef[]; sideEffectThrows?: string; pr?: number | null; ticket?: number | null }): {
  deps: AppGateDecisionDeps;
  rec: Recorder;
} {
  const rec: Recorder = { sideEffects: [], accepts: [], advances: [], audits: [], errors: [], views: 0 };
  const deps: AppGateDecisionDeps = {
    readRunState: () => (over.run === undefined ? GATE_RUN : over.run),
    resolveDef: () => ({ ok: true, def: defWithGate(over.gate ?? APPROVE_MARK_READY) }),
    refs: () => ({ pr: over.pr ?? 41, ticket: over.ticket ?? null }),
    bodyFile: () => '/repo/.agent-terminal/loop/artifacts/plan.md',
    runSideEffect: async (action, ctx) => {
      rec.sideEffects.push({ action, ctx });
      if (over.sideEffectThrows) throw new Error(over.sideEffectThrows);
    },
    persistAccept: (_r, state) => void rec.accepts.push(state),
    advanceFlow: (r) => void rec.advances.push(r),
    audit: (_r, cmd, exit) => void rec.audits.push({ cmd, exit }),
    emitError: (reason) => void rec.errors.push(reason),
    onViewChanged: () => void (rec.views += 1),
    ...over,
  };
  return { deps, rec };
}

const approve = (deps: AppGateDecisionDeps, step = 'plan', turnKey = 'consolidate-plan', option: GateDecisionOption = 'approve'): Promise<void> =>
  runAppGateDecision('/repo', step, turnKey, option, deps);

describe('runAppGateDecision — approve (§27.13 / AC2)', () => {
  it('runs the declared side-effect, persists the terminal accept, and advances the flow', async () => {
    const { deps, rec } = mkDeps({});
    await approve(deps);
    expect(rec.sideEffects).toEqual([{ action: 'mark-ready', ctx: { pr: 41, ticket: null, bodyFile: '/repo/.agent-terminal/loop/artifacts/plan.md' } }]);
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
});

describe('runAppGateDecision — a failed side-effect never strands the flow (§27.13 / AC3)', () => {
  it('surfaces + audits the failure but still persists the accept and advances', async () => {
    const { deps, rec } = mkDeps({ sideEffectThrows: 'no PR to mark ready' });
    await approve(deps);
    expect(rec.errors).toEqual(['approve side-effect failed: no PR to mark ready']); // surfaced to the operator
    expect(rec.audits.some((a) => a.cmd.includes('side-effect failed') && a.exit === 1)).toBe(true); // recorded
    expect(rec.accepts).toHaveLength(1); // accept NOT aborted
    expect(rec.advances).toEqual(['/repo']); // the flow still advances — a visible next action
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
});
