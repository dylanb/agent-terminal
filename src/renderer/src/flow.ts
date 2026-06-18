// Mocked Review-gate widget (§19.3): the view-3 gate panel renders from ONE fixture
// FlowState; its actions are stubbed — they reflect a verdict locally and notify an
// optional handler, but inject nothing (no agent-loop bridge yet, §18.3/§19.1). It is a
// placement-agnostic widget (UI-STANDARDS §1.2) — it takes a host + data.
//
// The fixture flow timeline + rail status that lived here were retired by §24.2.2 S1:
// the rail's flow status strip is now real (`flowStrip.ts`, driven by window.flow).

export type StepStatus = 'done' | 'active' | 'todo';
export interface FlowStep {
  name: string;
  status: StepStatus;
}

export type GateStatus = 'awaiting' | 'approved' | 'changes';
export interface FlowState {
  steps: FlowStep[];
  gate: { label: string; status: GateStatus; note: string };
  loop: { iteration: number; severity: string; openFindings: number; lastVerdict: string };
}

/** The Phase-1 sample flow: a review loop paused at the Review gate, iteration 3. */
export const SAMPLE_FLOW: FlowState = {
  steps: [
    { name: 'Plan', status: 'done' },
    { name: 'Code', status: 'done' },
    { name: 'Review', status: 'active' },
    { name: 'Ship', status: 'todo' },
  ],
  gate: { label: 'Review gate', status: 'awaiting', note: "Review came back — won't inject over a running process (§19.3)" },
  loop: { iteration: 3, severity: 'high', openFindings: 2, lastVerdict: 'changes requested' },
};

const pad2 = (n: number): string => String(n).padStart(2, '0');

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const GATE_TEXT: Record<GateStatus, string> = {
  awaiting: 'awaiting you',
  approved: 'approved',
  changes: 'changes requested',
};

export interface GatePanel {
  getStatus(): GateStatus;
}

/** View-3 gate panel: the three controls + the loop table. Approve / Request changes are
 *  stubs — they set the verdict locally and notify `onAct`, but inject nothing (§19.3). */
export function createGatePanel(
  host: HTMLElement,
  state: FlowState,
  handlers: { onAct?: (action: 'approve' | 'changes') => void } = {},
): GatePanel {
  let status: GateStatus = state.gate.status;

  // Before any action the row shows the loop's prior verdict; acting overwrites it.
  const verdict = el('span', 'lv', state.loop.lastVerdict);
  verdict.classList.toggle('bad', /change/i.test(state.loop.lastVerdict));
  const renderVerdict = (): void => {
    verdict.textContent = GATE_TEXT[status];
    verdict.classList.toggle('bad', status === 'changes');
  };

  const bar = el('div', 'gatebar');
  const approve = el('button', 'pill app', 'Approve gate') as HTMLButtonElement;
  const request = el('button', 'pill send', 'Request changes') as HTMLButtonElement;
  const open = el('button', 'pill', 'Open report') as HTMLButtonElement;
  bar.append(approve, request, open);

  const set = (next: GateStatus, action: 'approve' | 'changes'): void => {
    status = next;
    renderVerdict();
    handlers.onAct?.(action);
  };
  approve.addEventListener('click', () => set('approved', 'approve'));
  request.addEventListener('click', () => set('changes', 'changes'));

  const loop = el('div', 'loop');
  const row = (k: string, v: string, bad = false): HTMLElement => {
    const r = el('div', 'lrow');
    r.append(el('span', 'lk', k), el('span', 'ld'), el('span', `lv${bad ? ' bad' : ''}`, v));
    return r;
  };
  loop.append(
    row('iteration', pad2(state.loop.iteration)),
    row('severity cycle', state.loop.severity, true),
    row('open findings', String(state.loop.openFindings)),
  );
  const verdictRow = el('div', 'lrow');
  verdictRow.append(el('span', 'lk', 'last verdict'), el('span', 'ld'), verdict);
  loop.append(verdictRow);

  host.replaceChildren(el('div', 'sub', state.gate.note), bar, loop);
  return { getStatus: () => status };
}
