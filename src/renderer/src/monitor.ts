// Monitor pane (§9): status strip + captured blocks + inject actions.
// Architectural rule (§9.1): talks ONLY to window.monitor.* — never to the
// terminal pane, the renderer xterm, or the selection model.

import type { MonitorEvent, MonitorUpdateMsg } from '../../shared/ipc';

export function wireMonitorPane(): void {
  const statusEl = document.getElementById('monitor-status')!;
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

  function appendBlock(event: MonitorEvent): void {
    const block = document.createElement('div');
    block.className = 'capture-block';
    block.dataset.eventId = event.id;

    const meta = document.createElement('div');
    meta.className = 'capture-meta';
    meta.textContent = new Date(event.capturedAt).toLocaleTimeString();

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

  window.monitor.onUpdate((msg) => {
    last = msg;
    renderStatus();
    if (quietTick) clearInterval(quietTick);
    quietTick = msg.agentState === 'quiet' ? setInterval(renderStatus, 1000) : null;
  });

  window.monitor.onEvent((event) => appendBlock(event));

  window.monitor.onExit(() => {
    alive = false;
    renderStatus();
  });

  // Replay events captured before this pane (re)loaded (§8.4).
  void window.monitor.replay().then((events) => {
    for (const e of events) appendBlock(e);
  });

  renderStatus();
}
