// Mocked flow widgets (§24.1 / §19.2–§19.3): the flow timeline, rail gate/loop status,
// and the view-3 gate panel all render from ONE fixture FlowState. Phase 1 has no real
// flow-state.yaml / agent-loop bridge (§18.3/§19.1) — gate actions are stubbed: they
// reflect a verdict locally and notify an optional handler, but inject nothing. These
// are placement-agnostic widgets (UI-STANDARDS §1.2) — each takes a host + data.

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

/** "step N / M" naming the active step's position (§19.2). */
export function flowLabel(steps: FlowStep[]): string {
  const active = steps.findIndex((s) => s.status === 'active');
  const at = active >= 0 ? active + 1 : steps.filter((s) => s.status === 'done').length;
  return `step ${at} / ${steps.length}`;
}

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Vertical flow rail: one `.stn` per step, `.seg` connectors between (not after last). */
export function renderFlow(host: HTMLElement, steps: FlowStep[]): void {
  host.replaceChildren();
  steps.forEach((step, i) => {
    const stn = el('span', `stn ${step.status}`);
    stn.append(el('span', 'o'), el('span', 'nm', step.name));
    host.append(stn);
    if (i < steps.length - 1) host.append(el('span', step.status === 'done' ? 'seg' : 'seg future'));
  });
}

function statLine(key: string, value: string, valueClass = ''): HTMLElement {
  const stat = el('span', 'stat');
  stat.append(el('span', 'k', key), el('span', `v ${valueClass}`.trim(), value));
  return stat;
}

const GATE_TEXT: Record<GateStatus, string> = {
  awaiting: 'awaiting you',
  approved: 'approved',
  changes: 'changes requested',
};

/** Compact rail status: gate state + a one-line loop summary, from the fixture. */
export function renderRailStatus(host: HTMLElement, state: FlowState): void {
  host.replaceChildren();
  host.append(
    statLine('Gate', GATE_TEXT[state.gate.status], state.gate.status === 'awaiting' ? 'act' : 'sig'),
    statLine('Loop', `iter ${pad2(state.loop.iteration)} · ${state.loop.openFindings} open`),
  );
}

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
  open.disabled = true; // Phase-1 stub: no report wiring yet, so it must not present as actionable (§19.3)
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
