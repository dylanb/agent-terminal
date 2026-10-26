import { describe, expect, it, vi } from 'vitest';
import { createLoopBindingPreparer, type LoopBindingPreparerDeps } from '../../src/main/loopBinding';
import type { FlowStepDef } from '../../src/main/flow';
import type { LoopDefV2, LoopDefV2Result } from '../../src/main/loopDefV2';

// The loop entry seam's ONE domain answer for a bound loop step. The ORDER and the
// decisions live in this preparer; the operator-facing EFFECTS (the resolver reason on the loop-error path,
// the deferred revert + push, the tree copy) are injected, so the branching is tested at its own boundary
// without the flow machine or the filesystem (CLAUDE.md injection-seam). Positions 1 (marked) and 3 (missing
// input) are the seam's own and are covered by flowEntryActions.test.ts, not here.

const loopStep = (over: Partial<FlowStepDef> = {}): FlowStepDef => ({
  id: 'plan',
  kind: 'loop',
  loop: 'plan-loop',
  loopNamespace: 'app',
  ...over,
});

const def = (over: Partial<LoopDefV2> = {}): LoopDefV2 => ({ pickup: null, ...over } as LoopDefV2);
const resolvedFrom = (tierRoot: string, over: Partial<LoopDefV2> = {}): LoopDefV2Result => ({ ok: true, def: def(over), tierRoot, defDir: `${tierRoot}/loop` });

function deps(over: Partial<LoopBindingPreparerDeps> = {}): LoopBindingPreparerDeps {
  return {
    resolveDef: vi.fn(() => resolvedFrom('/operator')),
    canEnterWork: vi.fn(() => true),
    refuseUnresolved: vi.fn(),
    refuseAndRevert: vi.fn(),
    migrateIfBundled: vi.fn(() => null),
    ...over,
  };
}

describe('createLoopBindingPreparer', () => {
  it('position 2 — an unresolved def surfaces its reason on the loop-error path, does NOT revert, and refuses', () => {
    const d = deps({ resolveDef: vi.fn((): LoopDefV2Result => ({ ok: false, reason: 'no §27 def named plan-loop in any tier' })) });
    const result = createLoopBindingPreparer(d)(loopStep());
    expect(d.refuseUnresolved).toHaveBeenCalledWith('no §27 def named plan-loop in any tier');
    expect(d.refuseAndRevert).not.toHaveBeenCalled();
    expect(d.canEnterWork).not.toHaveBeenCalled();
    expect(d.migrateIfBundled).not.toHaveBeenCalled();
    expect(result).toEqual({ kind: 'refuse' });
  });

  it('position 4 — a step declaring bootstrap on a def with no pickup block reverts (above the readiness read) and refuses', () => {
    const d = deps({ resolveDef: vi.fn(() => resolvedFrom('/operator', { pickup: null })) });
    const result = createLoopBindingPreparer(d)(loopStep({ bootstrap: 'pickup' }));
    expect(d.refuseAndRevert).toHaveBeenCalledTimes(1);
    expect(d.canEnterWork).not.toHaveBeenCalled(); // position 4 sits above position 5
    expect(d.migrateIfBundled).not.toHaveBeenCalled();
    expect(result).toEqual({ kind: 'refuse' });
  });

  it('a step declaring bootstrap on a def that DOES declare pickup passes position 4 and reads readiness', () => {
    const pickup = {} as LoopDefV2['pickup'];
    const d = deps({ resolveDef: vi.fn(() => resolvedFrom('/operator', { pickup })) });
    createLoopBindingPreparer(d)(loopStep({ bootstrap: 'pickup' }));
    expect(d.refuseAndRevert).not.toHaveBeenCalled();
    expect(d.canEnterWork).toHaveBeenCalled();
  });

  it('a step declaring NO bootstrap never reaches position 4, even on a def with no pickup block', () => {
    const d = deps({ resolveDef: vi.fn(() => resolvedFrom('/operator', { pickup: null })) });
    const result = createLoopBindingPreparer(d)(loopStep());
    expect(d.refuseAndRevert).not.toHaveBeenCalled();
    expect(d.canEnterWork).toHaveBeenCalled();
    expect(result.kind).toBe('ready');
  });

  it('position 5 — a runner that cannot accept a turn now reverts, refuses, and migrates NOTHING', () => {
    const d = deps({ canEnterWork: vi.fn(() => false) });
    const result = createLoopBindingPreparer(d)(loopStep());
    expect(d.refuseAndRevert).toHaveBeenCalledTimes(1);
    expect(d.migrateIfBundled).not.toHaveBeenCalled(); // "nothing migrated" — position 5 above position 6
    expect(result).toEqual({ kind: 'refuse' });
  });

  it('position 6 — a ready binding forwards the migration notice migrateIfBundled produces', () => {
    const resolved = resolvedFrom('/app-bundled');
    const migrateIfBundled = vi.fn(() => 'Copied the built-in "plan-loop" loop into your config so you can customize it.');
    const d = deps({ resolveDef: vi.fn(() => resolved), migrateIfBundled });
    const step = loopStep();
    const result = createLoopBindingPreparer(d)(step);
    expect(migrateIfBundled).toHaveBeenCalledWith(step, resolved);
    expect(result).toEqual({ kind: 'ready', notice: 'Copied the built-in "plan-loop" loop into your config so you can customize it.' });
  });

  it('position 6 — a ready binding with nothing to migrate returns ready with no notice', () => {
    const d = deps({ migrateIfBundled: vi.fn(() => null) });
    const result = createLoopBindingPreparer(d)(loopStep());
    expect(result).toEqual({ kind: 'ready' });
    expect('notice' in result).toBe(false);
  });
});
