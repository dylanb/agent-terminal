// Monitor pane (§9/§15.6): status strip + command history + captured/semantic
// blocks + inject actions. Architectural rule (§9.1): talks ONLY to
// window.monitor.* — never to the terminal pane, the renderer xterm, or the
// selection model. All user-controlled text is set via textContent, never
// innerHTML, so command/output bytes cannot inject markup.

import type { CommandSummary, MonitorEvent, MonitorEventType, MonitorUpdateMsg } from '../../shared/ipc';

// While quiet, the "quiet for Ns" counter is re-rendered on this cadence (§8.3).
const QUIET_TICK_MS = 1000;

/** Friendly badge labels; unknown future types fall back to the raw type, never dropped (§15.6). */
const TYPE_LABELS: Record<string, string> = {
  capture: 'capture',
  'agent-question': 'agent-question',
  'permission-prompt': 'permission',
  'tool-use': 'tool',
  diff: 'diff',
  completion: 'completion',
  'command-output': 'command',
};

export function wireMonitorPane(): void {
  const statusEl = document.getElementById('monitor-status')!;
  const historyEl = document.getElementById('command-history')!;
  const blocksEl = document.getElementById('monitor-blocks')!;

  let alive = true;
  let last: MonitorUpdateMsg | null = null;
  let quietTick: ReturnType<typeof setInterval> | null = null;

  function renderStatus(): void {
    const state = last?.agentState ?? 'quiet';
    const quietFor =
      state === 'quiet' && last?.quietSince
        ? ` for ${Math.max(0, Math.round((Date.now() - last.quietSince) / 1000))}s`
        : '';
    statusEl.innerHTML = '';
    const items: Array<[string, string, boolean]> = [
      ['session', alive ? 'alive' : 'exited', alive],
      ['agent', state === 'active' ? 'working' : `quiet${quietFor}`, state === 'active'],
      ['full-screen', last?.altScreen ? 'yes' : 'no', !!last?.altScreen],
      ['paste mode', last?.bracketedPaste ? 'on' : 'off', !!last?.bracketedPaste],
    ];
    for (const [label, value, on] of items) {
      const chip = document.createElement('span');
      chip.className = `status-chip${on ? ' on' : ''}`;
      chip.dataset.status = label;
      chip.textContent = `${label}: ${value}`;
      statusEl.appendChild(chip);
    }
  }

  function renderCommands(commands: CommandSummary[]): void {
    historyEl.innerHTML = '';
    for (const c of commands) {
      const entry = document.createElement('div');
      entry.className = 'command-entry';
      entry.dataset.commandId = c.id;

      const cmd = document.createElement('span');
      cmd.className = 'command-text';
      cmd.textContent = c.command;

      const chip = document.createElement('span');
      chip.className = 'exit-chip';
      chip.textContent = c.running ? 'running' : `exit ${c.exitCode ?? '?'}`;
      if (c.truncated) chip.textContent += ' (truncated)';

      const capture = document.createElement('button');
      capture.textContent = 'Capture';
      // Fail-closed: we ask main to materialize the block; it flows back via
      // monitor:event only if the id is still valid (§15.4). No optimistic render.
      capture.addEventListener('click', () => window.monitor.captureCommand(c.id));

      entry.append(cmd, chip, capture);
      historyEl.appendChild(entry);
    }
  }

  function badgeLabel(type: MonitorEventType): string {
    return TYPE_LABELS[type] ?? type;
  }

  function appendBlock(event: MonitorEvent): void {
    const time = new Date(event.capturedAt).toLocaleTimeString();
    const block = document.createElement('div');
    block.className = 'capture-block';
    block.dataset.eventId = event.id;
    block.dataset.type = event.type;
    // Each block's buttons share a label, so scope them by capture time for screen readers (WCAG 2.4.6).
    block.setAttribute('role', 'group');
    block.setAttribute('aria-label', `${badgeLabel(event.type)} at ${time}`);

    const meta = document.createElement('div');
    meta.className = 'capture-meta';
    const badge = document.createElement('span');
    badge.className = 'capture-badge';
    badge.dataset.type = event.type;
    badge.textContent = badgeLabel(event.type);
    const timeEl = document.createElement('span');
    timeEl.className = 'capture-time';
    timeEl.textContent = time + (event.truncated ? ' · truncated' : '');
    meta.append(badge, timeEl);

    const pre = document.createElement('pre');
    pre.className = 'capture-text';
    pre.textContent = event.text;

    const actions = document.createElement('div');
    actions.className = 'capture-actions';
    const insert = document.createElement('button');
    insert.textContent = 'Insert into agent';
    insert.addEventListener('click', () => window.monitor.inject({ text: event.text, submit: false }));
    const submit = document.createElement('button');
    submit.textContent = 'Insert & submit';
    submit.addEventListener('click', () => window.monitor.inject({ text: event.text, submit: true }));
    actions.append(insert, submit);

    block.append(meta, pre, actions);
    blocksEl.appendChild(block);
  }

  function stopQuietTick(): void {
    if (quietTick) clearInterval(quietTick);
    quietTick = null;
  }

  function pullCommands(): void {
    void window.monitor.commands().then(renderCommands);
  }

  window.monitor.onUpdate((msg) => {
    last = msg;
    renderStatus();
    // A finished command produces output → quiescence transition → this tick;
    // re-pull the history so it stays live (§15.4).
    pullCommands();
    stopQuietTick();
    if (msg.agentState === 'quiet') quietTick = setInterval(renderStatus, QUIET_TICK_MS);
  });

  window.monitor.onEvent((event) => appendBlock(event));

  window.monitor.onExit(() => {
    alive = false;
    renderStatus();
  });

  // Replay events captured before this pane (re)loaded (§8.4), and load history.
  void window.monitor.replay().then((events) => {
    for (const e of events) appendBlock(e);
  });
  pullCommands();

  renderStatus();
}
