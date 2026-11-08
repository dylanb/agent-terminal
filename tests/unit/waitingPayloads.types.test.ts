import { describe, expect, it } from 'vitest';
import type { ControllerWorkActivity, ControllerWorkStatus, FlowDerived, MonitorUpdateMsg } from '../../src/shared/ipc';
import type { ControllerActivity } from '../../src/shared/waiting';
import { isControllerWorkStatus } from '../../src/shared/controllerStatus';
import { workStatus } from '../helpers/controllerStatusFixture';

// #319: no payload can carry Waiting without its value, or a Waiting value beside an active screen. `pnpm run
// typecheck` type-checks this file, so each @ts-expect-error below fails the run if its shape compiles.

const NODE = { program: 'node', others: 0 };

describe('the controller work status', () => {
  it('carries a Waiting value exactly when its activity is waiting, in its type and on the wire', () => {
    const { waiting: _waiting, ...base } = workStatus({ activity: 'quiet' });
    const waiting: ControllerWorkStatus = { ...base, activity: 'waiting', waiting: NODE };
    const quiet: ControllerWorkStatus = { ...base, activity: 'quiet' };
    // @ts-expect-error a Waiting activity with no Waiting value
    const bare: ControllerWorkStatus = { ...base, activity: 'waiting' };
    // @ts-expect-error a Waiting value beside another activity
    const beside: ControllerWorkStatus = { ...base, activity: 'active', waiting: NODE };
    expect([waiting, quiet, bare, beside].map(isControllerWorkStatus)).toEqual([true, true, false, false]);
  });

  it('takes every activity the Waiting detector reports, and the detector never reports unavailable', () => {
    const detected: ControllerActivity[] = [{ activity: 'active' }, { activity: 'quiet' }, { activity: 'waiting', waiting: NODE }];
    const sent: ControllerWorkActivity[] = detected;
    // @ts-expect-error unavailable is the controller's own activity, never the detector's
    const unavailable: ControllerActivity = { activity: 'unavailable' };
    expect([sent.length, unavailable.activity]).toEqual([3, 'unavailable']);
  });
});

describe('the window payloads', () => {
  it('carry a Waiting value only beside a quiet screen', () => {
    const monitor = { sessionId: 's', altScreen: false, bracketedPaste: false, quietSince: null } as const;
    const updates: MonitorUpdateMsg[] = [
      { ...monitor, agentState: 'quiet', waiting: NODE },
      { ...monitor, agentState: 'active', waiting: null },
      // @ts-expect-error a Waiting value beside an active screen
      { ...monitor, agentState: 'active', waiting: NODE },
    ];
    const todos = { todosDone: 0, todosTotal: 1, ready: false } as const;
    const derived: FlowDerived[] = [
      { ...todos, activity: 'quiet', waiting: NODE },
      { ...todos, activity: 'active', waiting: null },
      // @ts-expect-error a Waiting value beside an active screen
      { ...todos, activity: 'active', waiting: NODE },
    ];
    expect([updates.length, derived.length]).toEqual([3, 3]);
  });
});
