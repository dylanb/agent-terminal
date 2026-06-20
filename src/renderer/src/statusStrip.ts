// Status strip (§8.3 / §16.1): the session/agent/full-screen/paste chips plus the
// live "quiet for Ns" counter. Owns its own `last`/`alive` state and the 1 s tick;
// the counter is an aria-hidden child so the live region (WCAG 4.1.3) is not
// re-announced every second. Talks to nothing but its host element.

import type { MonitorUpdateMsg } from '../../shared/ipc';

// While quiet, the "quiet for Ns" counter is re-rendered on this cadence (§8.3).
const QUIET_TICK_MS = 1000;

export interface StatusStrip {
  /** A monitor:update tick: adopt the new state, repaint, and (re)start the quiet counter. */
  update(msg: MonitorUpdateMsg): void;
  /** Session exited: the chip flips to "exited". */
  setExited(): void;
  /** Initial paint before any update arrives. */
  render(): void;
  dispose(): void;
}

/** Injected seams (UI-STANDARDS §2.2): the clock is overridable so the quiet counter is testable. */
export interface StatusStripDeps {
  now?: () => number;
}

export function createStatusStrip(statusEl: HTMLElement, deps: StatusStripDeps = {}): StatusStrip {
  const doc = statusEl.ownerDocument;
  const now = deps.now ?? Date.now;
  let last: MonitorUpdateMsg | null = null;
  let alive = true;
  let quietCounterEl: HTMLElement | null = null;
  let quietTick: ReturnType<typeof setInterval> | null = null;

  function updateQuietCounter(): void {
    if (!quietCounterEl) return;
    const since = last?.quietSince;
    quietCounterEl.textContent = since ? ` for ${Math.max(0, Math.round((now() - since) / 1000))}s` : '';
  }

  function render(): void {
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
      const chip = doc.createElement('span');
      chip.className = `status-chip${on ? ' on' : ''}`;
      chip.dataset.status = label;
      chip.textContent = `${label}: ${value}`;
      if (label === 'agent' && state === 'quiet') {
        quietCounterEl = doc.createElement('span');
        quietCounterEl.className = 'quiet-counter';
        quietCounterEl.setAttribute('aria-hidden', 'true');
        chip.appendChild(quietCounterEl);
      }
      statusEl.appendChild(chip);
    }
    updateQuietCounter();
  }

  function stopQuietTick(): void {
    if (quietTick) clearInterval(quietTick);
    quietTick = null;
  }

  return {
    update(msg) {
      last = msg;
      render();
      stopQuietTick();
      if (msg.agentState === 'quiet') quietTick = setInterval(updateQuietCounter, QUIET_TICK_MS);
    },
    setExited() {
      alive = false;
      render();
    },
    render,
    dispose: stopQuietTick,
  };
}
