// Flow status strip (§22.3 / §24.2.2 S1) — a placement-agnostic organism
// (UI-STANDARDS §1.2): it renders the manual step's `position/total · name` and live
// status, plus a single control that follows the lifecycle — Start in not_started,
// Advance in in_progress, gone in done. It reaches for nothing: the flow lifecycle is
// injected as `deps` (the window.flow IPC seam), and each call returns the resulting
// state so the strip re-renders from the response.

import type { FlowApi, FlowStateView, FlowStatus } from '../../shared/ipc';

const STATUS_TEXT: Record<FlowStatus, string> = {
  not_started: 'not started',
  in_progress: 'in progress',
  done: 'done',
};

/** The control's label per status; null = no control (the step is done). */
const CONTROL: Record<FlowStatus, { label: string; act: 'start' | 'advance' } | null> = {
  not_started: { label: 'Start', act: 'start' },
  in_progress: { label: 'Advance', act: 'advance' },
  done: null,
};

export interface FlowStrip {
  /** (Re)pull the flow state and repaint. Call once on mount. */
  refresh(): Promise<void>;
}

export function createFlowStrip(host: HTMLElement, deps: FlowApi): FlowStrip {
  function render(state: FlowStateView): void {
    host.replaceChildren();

    const position = document.createElement('div');
    position.className = 'flow-pos';
    position.textContent = `${state.position}/${state.total} · ${state.stepName}`;

    const status = document.createElement('div');
    status.className = 'flow-status';
    status.dataset.status = state.status;
    status.textContent = STATUS_TEXT[state.status];

    host.append(position, status);

    const control = CONTROL[state.status];
    if (!control) return;

    const button = document.createElement('button');
    button.className = 'flow-control pill';
    button.textContent = control.label;
    button.addEventListener('click', () => {
      // Disable while the transition is in flight so a double-click can't fire it twice
      // (the machine would reject the second call anyway — §24.2.2 "a second Advance is
      // impossible" — but this keeps the UI honest). Re-render from the returned state.
      button.disabled = true;
      const next = control.act === 'start' ? deps.start() : deps.advance();
      next.then(render).catch(() => void refresh());
    });
    host.append(button);
  }

  async function refresh(): Promise<void> {
    render(await deps.state());
  }

  return { refresh };
}
