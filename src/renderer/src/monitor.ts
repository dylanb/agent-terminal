// Monitor pane (§9/§15.6): status strip + command history + captured/semantic
// blocks + inject/dismiss actions. Architectural rule (§9.1): talks ONLY to
// window.monitor.* — never to the terminal pane, the renderer xterm, or the
// selection model. All user-controlled text is set via textContent, never
// innerHTML, so command/output bytes cannot inject markup.
//
// v2.6: a `report` renders as a group whose `finding` children are individually
// actionable; every block/group/finding can be dismissed; blocks and command
// history are shown newest-first.

import type { CommandSummary, MonitorEvent, MonitorEventType, MonitorUpdateMsg } from '../../shared/ipc';

// While quiet, the "quiet for Ns" counter is re-rendered on this cadence (§8.3).
const QUIET_TICK_MS = 1000;

/** Friendly badge labels; unknown future types fall back to the raw type, never dropped (§15.6). */
const TYPE_LABELS: Record<string, string> = {
  capture: 'capture',
  report: 'report',
  finding: 'finding',
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
  let quietCounterEl: HTMLElement | null = null;
  const rendered = new Set<string>();
  // Findings whose parent report has not rendered yet (replay/live ordering safety).
  const orphans = new Map<string, MonitorEvent[]>();

  function badgeLabel(type: MonitorEventType): string {
    return TYPE_LABELS[type] ?? type;
  }

  function dismissButton(label: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'dismiss';
    btn.textContent = '×';
    btn.setAttribute('aria-label', label);
    btn.addEventListener('click', onClick);
    return btn;
  }

  function injectActions(text: string): HTMLElement {
    const actions = document.createElement('div');
    actions.className = 'capture-actions';
    const insert = document.createElement('button');
    insert.textContent = 'Insert into agent';
    insert.addEventListener('click', () => window.monitor.inject({ text, submit: false }));
    const submit = document.createElement('button');
    submit.textContent = 'Insert & submit';
    submit.addEventListener('click', () => window.monitor.inject({ text, submit: true }));
    actions.append(insert, submit);
    return actions;
  }

  function renderFinding(event: MonitorEvent): HTMLElement {
    const el = document.createElement('div');
    el.className = 'finding';
    el.dataset.eventId = event.id;
    const pre = document.createElement('pre');
    pre.className = 'capture-text';
    pre.textContent = event.text;
    el.append(
      pre,
      injectActions(event.text),
      dismissButton('Dismiss finding', () => {
        window.monitor.dismiss(event.id);
        el.remove();
      }),
    );
    return el;
  }

  function groupById(id: string): Element | null {
    for (const el of blocksEl.querySelectorAll('.capture-block')) {
      if ((el as HTMLElement).dataset.eventId === id) return el;
    }
    return null;
  }

  function attachFinding(event: MonitorEvent): void {
    const group = groupById(event.parentId!);
    if (!group) {
      const list = orphans.get(event.parentId!) ?? [];
      list.push(event);
      orphans.set(event.parentId!, list);
      return;
    }
    // First finding supersedes the report's whole-text fallback pre.
    group.querySelector('pre.report-full')?.remove();
    group.querySelector('.findings')!.appendChild(renderFinding(event));
  }

  function appendBlock(event: MonitorEvent): void {
    // Replay (§8.4) and the live monitor:event stream can both deliver the same id;
    // render each stored event exactly once.
    if (rendered.has(event.id)) return;
    rendered.add(event.id);

    if (event.type === 'finding') {
      attachFinding(event);
      return;
    }

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
    meta.append(
      badge,
      timeEl,
      dismissButton(`Dismiss ${badgeLabel(event.type)} at ${time}`, () => {
        window.monitor.dismiss(event.id); // main cascades to child findings (§15.6)
        block.remove();
      }),
    );
    block.append(meta);

    if (event.type === 'report') {
      // Whole-report actions, a fallback pre (removed once findings arrive), and a
      // container the findings nest into in natural order.
      block.append(injectActions(event.text));
      const full = document.createElement('pre');
      full.className = 'capture-text report-full';
      full.textContent = event.text;
      const findings = document.createElement('div');
      findings.className = 'findings';
      block.append(full, findings);
    } else {
      const pre = document.createElement('pre');
      pre.className = 'capture-text';
      pre.textContent = event.text;
      block.append(pre, injectActions(event.text));
    }

    // Newest-first: prepend top-level blocks (§15.6 / v2.6).
    blocksEl.insertBefore(block, blocksEl.firstChild);

    const pending = orphans.get(event.id);
    if (pending) {
      orphans.delete(event.id);
      for (const f of pending) attachFinding(f);
    }
  }

  function renderStatus(): void {
    const state = last?.agentState ?? 'quiet';
    statusEl.innerHTML = '';
    quietCounterEl = null;
    const items: Array<[string, string, boolean]> = [
      ['session', alive ? 'alive' : 'exited', alive],
      ['agent', state === 'active' ? 'working' : 'quiet', state === 'active'],
      ['full-screen', last?.altScreen ? 'yes' : 'no', !!last?.altScreen],
      ['paste mode', last?.bracketedPaste ? 'on' : 'off', !!last?.bracketedPaste],
    ];
    for (const [label, value, on] of items) {
      const chip = document.createElement('span');
      chip.className = `status-chip${on ? ' on' : ''}`;
      chip.dataset.status = label;
      chip.textContent = `${label}: ${value}`;
      // The "quiet for Ns" counter ticks every second; keeping it in an aria-hidden
      // child stops the aria-live status region re-announcing on every tick (WCAG 4.1.3).
      if (label === 'agent' && state === 'quiet') {
        quietCounterEl = document.createElement('span');
        quietCounterEl.className = 'quiet-counter';
        quietCounterEl.setAttribute('aria-hidden', 'true');
        chip.appendChild(quietCounterEl);
      }
      statusEl.appendChild(chip);
    }
    updateQuietCounter();
  }

  function updateQuietCounter(): void {
    if (!quietCounterEl) return;
    const since = last?.quietSince;
    quietCounterEl.textContent = since
      ? ` for ${Math.max(0, Math.round((Date.now() - since) / 1000))}s`
      : '';
  }

  function renderCommands(commands: CommandSummary[]): void {
    historyEl.innerHTML = '';
    // CommandSummary is newest-last; show newest at the top (§15.6 / v2.6).
    for (const c of [...commands].reverse()) {
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
      // Repeated "Capture" buttons need per-row accessible names (WCAG 2.4.6/4.1.2).
      capture.setAttribute('aria-label', `Capture output of: ${c.command}`);
      // Fail-closed: we ask main to materialize the block; it flows back via
      // monitor:event only if the id is still valid (§15.4). No optimistic render.
      capture.addEventListener('click', () => window.monitor.captureCommand(c.id));

      entry.append(cmd, chip, capture);
      historyEl.appendChild(entry);
    }
  }

  function stopQuietTick(): void {
    if (quietTick) clearInterval(quietTick);
    quietTick = null;
  }

  function pullCommands(): void {
    void window.monitor.commands().then(renderCommands);
  }

  // Dismiss-all toolbar (created here so the pane owns it; §9.1 — no terminal coupling).
  const toolbar = document.createElement('div');
  toolbar.className = 'blocks-toolbar';
  const dismissAll = document.createElement('button');
  dismissAll.id = 'dismiss-all';
  dismissAll.textContent = 'Dismiss all';
  dismissAll.addEventListener('click', () => {
    window.monitor.dismissAll();
    blocksEl.innerHTML = '';
    rendered.clear();
    orphans.clear();
  });
  toolbar.appendChild(dismissAll);
  blocksEl.parentNode?.insertBefore(toolbar, blocksEl);

  window.monitor.onUpdate((msg) => {
    last = msg;
    renderStatus();
    // A finished command produces output → quiescence transition → this tick;
    // re-pull the history so it stays live (§15.4).
    pullCommands();
    stopQuietTick();
    if (msg.agentState === 'quiet') quietTick = setInterval(updateQuietCounter, QUIET_TICK_MS);
  });

  window.monitor.onEvent((event) => appendBlock(event));

  // Mark-driven liveness (§15.5): command spans open/close independent of the §8.3
  // quiescence machinery, so refresh history on the tracker's change signal too.
  window.monitor.onCommandsChanged(() => pullCommands());

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
