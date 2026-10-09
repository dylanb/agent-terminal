import type { FlowStatus } from '../shared/ipc';

export interface SliceReopenView {
  status: FlowStatus;
  stepName: string;
}

export interface SliceReopenPorts<V extends SliceReopenView> {
  state(): V;
  reopen(): V;
  sliceStartStep(): string | null;
  record(pre: V, after: V): void;
}

// §28.4.2 / §25 — `reopened` fires before `record` so the human decision entry lands in the gate's step window;
// recording the re-entry first would attribute the decision to RED's.
export function reopenSliceTransition<V extends SliceReopenView>(ports: SliceReopenPorts<V>, reopened: () => void): boolean {
  const pre = ports.state();
  if (pre.status !== 'in_progress') return false;
  const view = ports.reopen();
  const landed = view.status === 'in_progress' && view.stepName === ports.sliceStartStep();
  if (landed) reopened();
  ports.record(pre, view);
  return landed;
}
