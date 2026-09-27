// §18.7.3 / §18.7.4

import type { RebindChoice, RebindResult } from '../shared/ipc';
import { offersHeldRunRecovery, type HeldRunView } from '../shared/runHold';
import { displaySafeEcho, MAX_ECHOED_REASON_LENGTH } from '../shared/controlChars';
import { errMsg } from './errno';
import { hasFlowDefinition, resumesAt, type FlowDefinition, type FlowLoad } from './flow';
import type { DispositionRead } from './resolveRunDefinition';
import { clearDisposition, recordDisposition } from './runDisposition';
import { createBoundSourceLoader } from './runResolver';
import { heldRunOf } from './runHoldRead';
import type { WorktreeLock } from './worktreeLock';

/** The held step here is the raw persisted id: `resumesAt` matches it, and only a display copy is ever echoed. */
export type HeldRead = HeldRunView;

export interface HeldRunRecoveryDeps {
  lock: Pick<WorktreeLock, 'withWorktreeLock'>;
  hold(worktree: string): HeldRead;
  loadBound(worktree: string, binding: DispositionRead): FlowLoad;
  resumesAt(definition: FlowDefinition, step: string): boolean;
  rebindRecord(worktree: string, binding: DispositionRead): void;
}

export interface HeldRunRecovery {
  rebind(worktree: string, choice: RebindChoice): RebindResult;
}

/** §18.7.3 — replace a missing or unreadable run record with `binding`. */
export function rebindRunRecord(worktree: string, binding: DispositionRead): void {
  clearDisposition(worktree);
  recordDisposition(worktree, binding);
}

export function realHeldRunRecoveryDeps(globalDir: string): Omit<HeldRunRecoveryDeps, 'lock'> {
  return { hold: heldRunOf, loadBound: createBoundSourceLoader(globalDir), resumesAt, rebindRecord: rebindRunRecord };
}

const NOT_HELD_REASON = 'This run is not waiting to be recovered, so there is nothing to recover onto a flow.';
const NO_LOCAL_FLOW_REASON = "This worktree has no flow.yaml of its own to recover the run onto.";

const refuse = (reason: string): RebindResult => ({ ok: false, reason: displaySafeEcho(reason, MAX_ECHOED_REASON_LENGTH) });

function bindingFor(choice: RebindChoice): DispositionRead {
  switch (choice.origin) {
    case 'local':
      return { source: 'non-catalog' };
    case 'fallback':
      return { source: 'fallback' };
    case 'repo':
    case 'global':
      return { source: 'catalog', tier: choice.origin, id: choice.id };
    default:
      return choice satisfies never;
  }
}

export function createHeldRunRecovery(deps: HeldRunRecoveryDeps): HeldRunRecovery {
  const rebindHeld = (worktree: string, choice: RebindChoice): RebindResult => {
    const held = deps.hold(worktree);
    if (!offersHeldRunRecovery(held)) return refuse(NOT_HELD_REASON);
    // A non-catalog binding follows the live local↔global chain, so without a local flow.yaml it would load the
    // global fallback rather than the flow the operator chose.
    if (choice.origin === 'local' && !hasFlowDefinition(worktree)) return refuse(NO_LOCAL_FLOW_REASON);
    const binding = bindingFor(choice);
    const load = deps.loadBound(worktree, binding);
    if (!load.ok) return refuse(`The chosen flow could not be loaded: ${load.error}`);
    if (!deps.resumesAt(load.definition, held.step)) {
      return refuse(`The chosen flow does not contain the current step "${held.step}"; choose a flow that does, or Terminate the run.`);
    }
    try {
      deps.rebindRecord(worktree, binding);
    } catch (e) {
      return refuse(`The run could not be recovered onto the chosen flow: ${errMsg(e)}`);
    }
    return { ok: true, outcome: 'resumed' };
  };

  return {
    rebind(worktree, choice) {
      const locked = deps.lock.withWorktreeLock(worktree, () => rebindHeld(worktree, choice));
      if (locked.ok) return locked.value;
      return { ok: false, reason: `The run could not be recovered: ${locked.reason}` };
    },
  };
}
