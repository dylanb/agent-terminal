import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { createWorktreeFixture } from '../helpers/worktreeFixture';
import * as gateModule from '../../src/main/activeFlowGate';
import { readActiveFlow, writeActiveFlow } from '../../src/main/activeFlowPointer';
import { createWorktreeLock } from '../../src/main/worktreeLock';

// A3 (#134) T6 step 4 — the gate's check-then-write body is reachable only from inside a worktree lock scope
// (CWE-367): `selectIfUnlocked` takes the `WorktreeLockScope` token `withWorktreeLock` hands its callback, so a
// call without one does not compile. `pnpm run build` type-checks this file.

describe('selectIfUnlocked — the gate body behind a lock-scope token', () => {
  const fx = createWorktreeFixture();
  afterEach(() => fx.cleanup());

  it('writes and clears the selection from inside a lock scope, and a token-less call is a compile error', () => {
    expect(typeof gateModule.selectIfUnlocked).toBe('function');
    const wt = fx.makeWorktree('a3-scope-token');
    const lock = createWorktreeLock({ lockRoot: join(fx.outsideDir('a3-scope-locks'), 'locks'), holderLiveness: () => 'live-matching' });

    const set = lock.withWorktreeLock(wt, (scope) => gateModule.selectIfUnlocked(scope, wt, { kind: 'set', id: 'scoped-flow' }));
    expect(set).toEqual({ ok: true, value: { ok: true } });
    expect(readActiveFlow(wt)).toEqual({ kind: 'value', id: 'scoped-flow' });

    writeActiveFlow(wt, 'scoped-flow');
    const cleared = lock.withWorktreeLock(wt, (scope) => gateModule.selectIfUnlocked(scope, wt, { kind: 'unset' }));
    expect(cleared).toEqual({ ok: true, value: { ok: true } });
    expect(readActiveFlow(wt)).toEqual({ kind: 'unset' });

    const tokenless = (): unknown =>
      // @ts-expect-error — no WorktreeLockScope: the lock-free body is unreachable outside a lock scope
      gateModule.selectIfUnlocked({}, wt, { kind: 'unset' });
    expect(tokenless).toBeTypeOf('function');

    type Scope = Parameters<typeof gateModule.selectIfUnlocked>[0];
    const forged = {} as { [K in keyof Scope as K extends string ? K : never]: Scope[K] };
    const forgedToken = (): unknown =>
      // @ts-expect-error — a hand-built look-alike is not a WorktreeLockScope: the token is branded, so only a lock scope can mint one
      gateModule.selectIfUnlocked(forged, wt, { kind: 'unset' });
    expect(forgedToken).toBeTypeOf('function');
  });
});
