// Flow lifecycle state machine (§18.2 / §24.2.2 S1). The walking skeleton: a single
// manual step driven not_started --start--> in_progress --advance--> done; done is
// terminal. Illegal transitions throw, so "a second Advance is impossible" is a
// machine-level invariant, not just a UI affordance.
//
// The step definition is a HARDCODED constant — the one deliberate seam this slice
// carries; S2 replaces it with a real `.agent-terminal/flow.yaml` read (§18.1).

import type { FlowStateView, FlowStatus } from '../shared/ipc';

interface StepDef {
  id: string;
  name: string;
}

/** S1 seam: the single manual step, hardcoded (replaced by flow.yaml in S2). */
const STEP: StepDef = { id: 'step-1', name: 'Manual step' };

export interface FlowMachine {
  state(): FlowStateView;
  /** not_started → in_progress; throws on any other current status. */
  start(): FlowStateView;
  /** in_progress → done; throws on any other current status. */
  advance(): FlowStateView;
}

export function createFlowMachine(): FlowMachine {
  let status: FlowStatus = 'not_started';

  const view = (): FlowStateView => ({ stepName: STEP.name, position: 1, total: 1, status });

  const transition = (from: FlowStatus, to: FlowStatus): FlowStateView => {
    if (status !== from) {
      throw new Error(`illegal flow transition: ${status} cannot move to ${to}`);
    }
    status = to;
    return view();
  };

  return {
    state: view,
    start: () => transition('not_started', 'in_progress'),
    advance: () => transition('in_progress', 'done'),
  };
}
