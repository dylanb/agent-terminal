// Shadow screen model (§8): every PTY byte is teed here. Owns the headless
// terminal, the quiescence detector, and the debounced status publisher.

import { Terminal as HeadlessTerminal } from '@xterm/headless';
import type { AgentState } from '../shared/ipc';
import { createQuiescenceDetector, QUIET_MS } from './quiescence';

export const SETTLE_MS = 80;

export interface ShadowStatus {
  altScreen: boolean;
  bracketedPaste: boolean;
  agentState: AgentState;
  quietSince: number | null;
}

export interface ShadowModel {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** Live bracketed-paste mode — read at injection time, never cached (§9.3). */
  isBracketedPaste(): boolean;
  /** Visible-buffer text via the public read path (capture substrate / debugging, §8.2). */
  snapshotText(): string;
  dispose(): void;
}

export function createShadowModel(opts: {
  cols?: number;
  rows?: number;
  scrollback?: number;
  settleMs?: number;
  quietMs?: number;
  onStatus: (status: ShadowStatus) => void;
  now?: () => number;
}): ShadowModel {
  const settleMs = opts.settleMs ?? SETTLE_MS;
  const term = new HeadlessTerminal({
    cols: opts.cols ?? 80,
    rows: opts.rows ?? 24,
    scrollback: opts.scrollback ?? 5000,
    allowProposedApi: true,
  });

  let last: ShadowStatus | null = null;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const detector = createQuiescenceDetector({
    quietMs: opts.quietMs ?? QUIET_MS,
    now: opts.now,
    // Transitions publish immediately — don't wait for the settle debounce (§8.3).
    onTransition: () => publishStatus(),
  });

  function currentStatus(): ShadowStatus {
    return {
      altScreen: term.buffer.active.type === 'alternate',
      bracketedPaste: term.modes.bracketedPasteMode,
      agentState: detector.state,
      quietSince: detector.quietSince,
    };
  }

  function publishStatus() {
    if (disposed) return;
    const status = currentStatus();
    if (
      !last ||
      status.altScreen !== last.altScreen ||
      status.bracketedPaste !== last.bracketedPaste ||
      status.agentState !== last.agentState
    ) {
      last = status;
      opts.onStatus(status);
    }
  }

  return {
    write(data) {
      if (disposed) return; // onData can race window close (§4G)
      term.write(data);
      detector.noteOutputActivity();
      if (settleTimer) clearTimeout(settleTimer);
      // Agents redraw in bursts; read shadow state only after writes settle (§8.2).
      settleTimer = setTimeout(publishStatus, settleMs);
    },
    resize(cols, rows) {
      if (disposed) return;
      term.resize(cols, rows);
    },
    isBracketedPaste() {
      return term.modes.bracketedPasteMode;
    },
    snapshotText() {
      const buf = term.buffer.active;
      const lines: string[] = [];
      for (let y = 0; y < buf.length; y++) {
        lines.push(buf.getLine(y)?.translateToString(true) ?? '');
      }
      return lines.join('\n');
    },
    dispose() {
      disposed = true;
      if (settleTimer) clearTimeout(settleTimer);
      detector.dispose();
      term.dispose();
    },
  };
}
