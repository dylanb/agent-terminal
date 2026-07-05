import type { LoopGate } from '../../src/main/loopDef';

// Test factory for a LoopGate that carries only the read-slice fields (id/kind/humanOptions/terminal)
// a flow-view test cares about; the §26.6 gate-action fields (on*/nextStatus*) default to empty. Tests
// that exercise the gate transition (gateActions) parse a real LoopDef instead of using this.
export function mkGate(g: Pick<LoopGate, 'id' | 'kind' | 'humanOptions' | 'terminal'>): LoopGate {
  return {
    onApprove: [],
    onRequestChanges: [],
    onImpasse: [],
    nextStatusOnApprove: '',
    nextStatusOnRequestChanges: '',
    nextStatusOnImpasse: '',
    ...g,
  };
}
