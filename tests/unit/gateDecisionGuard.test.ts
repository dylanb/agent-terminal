import { describe, expect, it, vi } from 'vitest';
import { createGuardedGateDecision, markedBindingRefusal, stepLoopBinding } from '../../src/main/gateDecisionGuard';
import { MARKED_BINDING_REASON } from '../../src/shared/loopNamespace';
import type { FlowStepDef } from '../../src/main/flow';

// AC 4: the gate-decision seam is the THIRD marked-binding seam. `runAppGateDecision`
// selects its engine from the persisted run state and reads no namespace, and its IPC entry validates payload
// shape only — so a step that acquires `loop_namespace: legacy` while its run state already sits at a verdict
// still lets `approve` reach the OUTWARD-FACING GitHub side effect. The refusal is sited in the composition
// root's wiring (CLAUDE.md: the policy authorizing an outward-facing operation is checked AT the operation,
// not at the renderer control that precedes it), and the lookup is BY STEP ID — never the flow's current
// position, which for a step the flow has advanced past would read the wrong, unmarked step (§6).

const step = (id: string, over: Partial<FlowStepDef> = {}): FlowStepDef => ({ id, kind: 'loop', loop: id, ...over });

describe('stepLoopBinding — the binding a gate decision acts on, looked up BY ID (§6)', () => {
  // The flow has ADVANCED past the marked step: 'plan' (legacy) precedes the current 'build' (app). A
  // position-keyed lookup would read 'build' (unmarked) for a decision whose payload names 'plan'.
  const steps = [step('plan', { loopNamespace: 'legacy' }), step('build', { loopNamespace: 'app' })];

  it('returns the named step\'s binding regardless of its position in the flow', () => {
    expect(stepLoopBinding(steps, 'plan')).toBe('legacy');
    expect(stepLoopBinding(steps, 'build')).toBe('app');
  });

  it('defaults an omitted loop_namespace to the surviving engine', () => {
    expect(stepLoopBinding([step('build')], 'build')).toBe('app');
  });

  it('is null for a non-loop step or an unknown id (nothing to refuse)', () => {
    expect(stepLoopBinding([step('groom', { kind: 'manual', loop: undefined })], 'groom')).toBeNull();
    expect(stepLoopBinding(steps, 'no-such-step')).toBeNull();
  });
});

describe('createGuardedGateDecision — the outward-facing side effect never runs for a marked binding', () => {
  const guarded = (binding: ReturnType<typeof stepLoopBinding>) => {
    const run = vi.fn(async () => true);
    const refuse = vi.fn();
    const decide = createGuardedGateDecision({ bindingOf: () => binding, refuse, run });
    return { run, refuse, decide };
  };

  it('refuses a legacy-marked step: emits the reason, returns false, and NEVER calls the runner (no side effect)', async () => {
    const { run, refuse, decide } = guarded('legacy');
    const result = await decide('/repo', 'plan', 'consolidate-plan', 'approve');
    expect(result).toBe(false);
    expect(refuse).toHaveBeenCalledWith(MARKED_BINDING_REASON);
    expect(run).not.toHaveBeenCalled(); // runSideEffect / persistAccept / advanceFlow all live inside run
  });

  it('runs the decision for a surviving (app) binding', async () => {
    const { run, refuse, decide } = guarded('app');
    await decide('/repo', 'build', 'consolidate-build', 'approve', 'note');
    expect(refuse).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledWith('/repo', 'build', 'consolidate-build', 'approve', 'note');
  });

  it('runs the decision when the binding is unknown (null) — only a CONFIRMED marked binding refuses', async () => {
    const { run, refuse, decide } = guarded(null);
    await decide('/repo', 'build', 'consolidate-build', 'request-changes');
    expect(refuse).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledOnce();
  });
});

// #137 S1 — the refusal as a domain predicate, so the engine approve and the guarded human runner share one check.
describe('markedBindingRefusal — the refusal both deciders call (#137 S1)', () => {
  it('names the marked-binding reason for a step that binds the retired engine', () => {
    expect(markedBindingRefusal(() => 'legacy', '/repo', 'plan')).toBe(MARKED_BINDING_REASON);
  });

  it.each([
    ['a surviving (app) binding', 'app' as const],
    ['an unknown (null) binding', null],
  ])('refuses nothing for %s (negative pair)', (_label, binding) => {
    expect(markedBindingRefusal(() => binding, '/repo', 'build')).toBeNull();
  });

  it('refuses by the step it is asked about, not another step of the same flow', () => {
    const bindingOf = (_repoKey: string, step: string) => (step === 'plan' ? ('legacy' as const) : ('app' as const));
    expect(markedBindingRefusal(bindingOf, '/repo', 'plan')).toBe(MARKED_BINDING_REASON);
    expect(markedBindingRefusal(bindingOf, '/repo', 'build')).toBeNull();
  });
});
