// Mocked Review-gate widget (§19.3): a placement-agnostic widget (UI-STANDARDS §1.2) whose actions
// are stubbed — they reflect a verdict locally but inject nothing (no agent-loop bridge yet,
// §18.3/§19.1).

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

/** Fixture: a review loop paused at the Review gate. */
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

// host-document invariant (UI-STANDARDS): build from the host's document, not global.
type El = (tag: string, className?: string, text?: string) => HTMLElement;
const makeEl = (doc: Document): El => (tag, className, text) => {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

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
  const el = makeEl(host.ownerDocument);
  let status: GateStatus = state.gate.status;

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
  open.disabled = true; // stub: no report wiring yet, must not present as actionable (§19.3)
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
    row('severity cycle', state.loop.severity, /^(high|critical)$/i.test(state.loop.severity)),
    row('open findings', String(state.loop.openFindings)),
  );
  const verdictRow = el('div', 'lrow');
  verdictRow.append(el('span', 'lk', 'last verdict'), el('span', 'ld'), verdict);
  loop.append(verdictRow);

  host.replaceChildren(el('div', 'sub', state.gate.note), bar, loop);
  return { getStatus: () => status };
}
