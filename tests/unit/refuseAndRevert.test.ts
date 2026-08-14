import { describe, expect, it, vi } from 'vitest';
import { createRefuseAndRevert, type FlowEntryIdentity } from '../../src/main/loopBinding';

// §B.5 positions 4/5 (AC 10) — the bootstrap-refusal EFFECT: surface the durable error, then DEFER an
// identity-guarded revert + push so the flow never sits `in_progress` with no run. The entry action fires
// inside advance's enter(view()), whose reply view was captured at the entered step; a synchronous revert's
// push would be overwritten by that stale reply, so the revert rides a later tick and re-checks the entry
// token, status, step and issue — landing ONLY if the flow still sits where the refusal was raised. The
// decision (which position fires) is tested against a mocked refuseAndRevert in loopBinding.test.ts; this
// tests the effect's own observable behavior — the IPC error it emits and whether the guarded revert fires.

const ID = (over: Partial<FlowEntryIdentity> = {}): FlowEntryIdentity => ({ step: 'build', status: 'in_progress', issue: 42, ...over });

function harness(opts: { atEmit?: FlowEntryIdentity; atDefer?: FlowEntryIdentity; token?: number; entryToken?: number } = {}) {
  const emitError = vi.fn();
  const revert = vi.fn();
  const push = vi.fn();
  let deferred: (() => void) | null = null;
  const token = opts.token ?? 1;
  const refuse = createRefuseAndRevert({
    activeOccurrence: () => ({ repoKey: '/repo', token }),
    entryToken: () => opts.entryToken ?? token,
    // first call (emit) sees atEmit; the deferred call sees atDefer (defaults to the same identity)
    identity: vi.fn().mockReturnValueOnce(opts.atEmit ?? ID()).mockReturnValue(opts.atDefer ?? opts.atEmit ?? ID()),
    emitError,
    revert,
    push,
    defer: (fn) => { deferred = fn; },
  });
  return { refuse, emitError, revert, push, runDeferred: () => deferred?.() };
}

describe('createRefuseAndRevert — surface the error, then an identity-guarded deferred revert (§B.5 4/5)', () => {
  it('emits the durable bootstrap error for the entered step, synchronously', () => {
    const h = harness({ atEmit: ID({ step: 'build' }) });
    h.refuse('no pickup to run');
    expect(h.emitError).toHaveBeenCalledWith('/repo', 'build', 'no pickup to run');
    expect(h.revert).not.toHaveBeenCalled(); // the revert is DEFERRED, not synchronous
  });

  it('reverts and pushes on the next tick when the flow still sits at the entered step', () => {
    const h = harness();
    h.refuse('no pickup to run');
    h.runDeferred();
    expect(h.revert).toHaveBeenCalledWith('/repo', 'build');
    expect(h.push).toHaveBeenCalledOnce();
  });

  it('does NOT revert when a newer entry has superseded this one (token drift)', () => {
    const h = harness({ token: 1, entryToken: 2 });
    h.refuse('no pickup to run');
    h.runDeferred();
    expect(h.revert).not.toHaveBeenCalled();
    expect(h.push).not.toHaveBeenCalled();
  });

  it('does NOT revert when the flow has moved to another step, left in_progress, or changed issue by defer time', () => {
    for (const drift of [ID({ step: 'ship' }), ID({ status: 'done' }), ID({ issue: 99 })]) {
      const h = harness({ atEmit: ID(), atDefer: drift });
      h.refuse('no pickup to run');
      h.runDeferred();
      expect(h.revert, `drift ${JSON.stringify(drift)}`).not.toHaveBeenCalled();
    }
  });

  it('is a no-op when no entry is in flight', () => {
    const emitError = vi.fn();
    const refuse = createRefuseAndRevert({
      activeOccurrence: () => null,
      entryToken: () => undefined,
      identity: () => ID(),
      emitError,
      revert: vi.fn(),
      push: vi.fn(),
      defer: (fn) => fn(),
    });
    refuse('no pickup to run');
    expect(emitError).not.toHaveBeenCalled();
  });
});
