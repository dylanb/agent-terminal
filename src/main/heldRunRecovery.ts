// §18.7.3 / §18.7.4

import type { MissingStepAction, RebindChoice, RebindResult, RecoveryOutcomeOf } from '../shared/ipc';
import { offersHeldRunRecovery, type HeldRunView } from '../shared/runHold';
import { displaySafeEcho, MAX_ECHOED_REASON_LENGTH } from '../shared/controlChars';
import { errMsg } from './errno';
import { hasFlowDefinition, resumesAt, type FlowDefinition, type FlowLoad, type TerminateResult } from './flow';
import type { PointerWrite, SelectResult } from './activeFlowGate';
import { resolveCatalogEntry } from './flowCatalog';
import type { CatalogResolution, DispositionRead } from './resolveRunDefinition';
import { clearDisposition, recordDisposition } from './runDisposition';
import { createBoundSourceLoader } from './runResolver';
import { heldRunOf } from './runHoldRead';
import type { WorktreeLock, WorktreeLockScope } from './worktreeLock';

/** The held step here is the raw persisted id: `resumesAt` matches it, and only a display copy is ever echoed. */
export type HeldRead = HeldRunView;

export interface HeldRunRecoveryDeps {
  lock: Pick<WorktreeLock, 'withWorktreeLock'>;
  hold(worktree: string): HeldRead;
  loadBound(worktree: string, binding: DispositionRead): FlowLoad;
  resumesAt(definition: FlowDefinition, step: string): boolean;
  rebindRecord(worktree: string, binding: DispositionRead): void;
  /** The tier-less resolution a bare-id pointer write takes at the next load. */
  selectionResolves(worktree: string, id: string): CatalogResolution;
  terminate(worktree: string): TerminateResult;
  selectIfUnlocked(scope: WorktreeLockScope, worktree: string, write: PointerWrite): SelectResult;
}

export interface HeldRunRecovery {
  rebind(worktree: string, choice: RebindChoice, ifStepMissing: MissingStepAction): RebindResult;
  outcomes(worktree: string, choices: RebindChoice[]): RecoveryOutcomeOf[];
}

/** §18.7.3 — replace a missing or unreadable run record with `binding`. */
export function rebindRunRecord(worktree: string, binding: DispositionRead): void {
  clearDisposition(worktree);
  recordDisposition(worktree, binding);
}

export function realHeldRunRecoveryDeps(
  globalDir: string,
): Omit<HeldRunRecoveryDeps, 'lock' | 'terminate' | 'selectIfUnlocked'> {
  return {
    hold: heldRunOf,
    loadBound: createBoundSourceLoader(globalDir),
    resumesAt,
    rebindRecord: rebindRunRecord,
    selectionResolves: (worktree, id) => resolveCatalogEntry({ worktreeDir: worktree, globalRoot: globalDir }, id),
  };
}

const NOT_HELD_REASON = 'This run is not waiting to be recovered, so there is nothing to recover onto a flow.';
const NO_LOCAL_FLOW_REASON = "This worktree has no flow.yaml of its own to recover the run onto.";

const shadowedReason = (id: string): string =>
  `A different flow named "${id}" would be selected instead of the one chosen; choose the repo entry, or Terminate the run.`;

const unselectableReason = (id: string): string =>
  `The flow "${id}" cannot be selected, because the repo catalog's entry of that name cannot be used; choose a different flow, or Terminate the run.`;

const terminatedWith = (notice: string): RebindResult => ({
  ok: true,
  outcome: 'terminated',
  notice: displaySafeEcho(notice, MAX_ECHOED_REASON_LENGTH),
});

const unconfirmedEndReason = (step: string): string =>
  `Choosing this flow ends the run, so it needs your confirmation first: the flow has no step "${step}".`;

type Verdict = { kind: 'refused'; reason: string } | { kind: 'resumes'; binding: DispositionRead } | { kind: 'ends' };

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

function pointerWriteFor(choice: RebindChoice): PointerWrite {
  switch (choice.origin) {
    case 'local':
    case 'fallback':
      return { kind: 'unset' };
    case 'repo':
    case 'global':
      return { kind: 'set', id: choice.id };
    default:
      return choice satisfies never;
  }
}

export function createHeldRunRecovery(deps: HeldRunRecoveryDeps): HeldRunRecovery {
  const endAndSelect = (scope: WorktreeLockScope, worktree: string, choice: RebindChoice): RebindResult => {
    if (choice.origin === 'repo' || choice.origin === 'global') {
      const resolved = deps.selectionResolves(worktree, choice.id);
      if (!resolved.ok) return refuse(unselectableReason(choice.id));
      if (resolved.tier !== choice.origin) return refuse(shadowedReason(choice.id));
    }
    const ended = deps.terminate(worktree);
    if (ended.outcome === 'refused') return refuse(ended.cause === 'failed' ? ended.reason : NOT_HELD_REASON);
    const write = pointerWriteFor(choice);
    const selected = deps.selectIfUnlocked(scope, worktree, write);
    if (selected.ok) return { ok: true, outcome: 'terminated' };
    if (selected.cause === 'run-begun') return terminatedWith(ended.view.notice ?? selected.reason);
    if (write.kind === 'unset') {
      return terminatedWith(`The run was ended, but the saved selection could not be cleared: ${selected.error}`);
    }
    // A stale earlier pick must not outlive the operator's choice of a different flow.
    const cleared = deps.selectIfUnlocked(scope, worktree, { kind: 'unset' });
    const outcome = cleared.ok ? 'The run was ended and the default flow is selected instead' : 'The run was ended';
    return terminatedWith(`${outcome}, because the chosen flow could not be selected: ${selected.error}`);
  };

  const verdictFor = (worktree: string, step: string, choice: RebindChoice): Verdict => {
    // A non-catalog binding follows the live local↔global chain, so without a local flow.yaml it would load the
    // global fallback rather than the flow the operator chose.
    if (choice.origin === 'local' && !hasFlowDefinition(worktree)) return { kind: 'refused', reason: NO_LOCAL_FLOW_REASON };
    const binding = bindingFor(choice);
    const load = deps.loadBound(worktree, binding);
    if (!load.ok) return { kind: 'refused', reason: `The chosen flow could not be loaded: ${load.error}` };
    return deps.resumesAt(load.definition, step) ? { kind: 'resumes', binding } : { kind: 'ends' };
  };

  const rebindHeld = (scope: WorktreeLockScope, worktree: string, choice: RebindChoice, ifStepMissing: MissingStepAction): RebindResult => {
    const held = deps.hold(worktree);
    if (!offersHeldRunRecovery(held)) return refuse(NOT_HELD_REASON);
    const verdict = verdictFor(worktree, held.step, choice);
    if (verdict.kind === 'refused') return refuse(verdict.reason);
    if (verdict.kind === 'ends') {
      return ifStepMissing === 'end-run' ? endAndSelect(scope, worktree, choice) : refuse(unconfirmedEndReason(held.step));
    }
    try {
      deps.rebindRecord(worktree, verdict.binding);
    } catch (e) {
      return refuse(`The run could not be recovered onto the chosen flow: ${errMsg(e)}`);
    }
    return { ok: true, outcome: 'resumed' };
  };

  return {
    rebind(worktree, choice, ifStepMissing) {
      const locked = deps.lock.withWorktreeLock(worktree, (scope) => rebindHeld(scope, worktree, choice, ifStepMissing));
      if (locked.ok) return locked.value;
      return { ok: false, reason: `The run could not be recovered: ${locked.reason}` };
    },
    outcomes(worktree, choices) {
      const held = deps.hold(worktree);
      if (!offersHeldRunRecovery(held)) return [];
      return choices.flatMap((choice) => {
        const verdict = verdictFor(worktree, held.step, choice);
        return verdict.kind === 'refused' ? [] : [{ choice, outcome: verdict.kind }];
      });
    },
  };
}
