// Quiescence detection (§8.3): 'active' while bytes arrive, 'quiet' after quietMs of silence.

import type { AgentState } from '../shared/ipc';

export const QUIET_MS = 1000;

export interface QuiescenceOptions {
  quietMs?: number;
  onTransition: (state: AgentState, quietSince: number | null) => void;
  now?: () => number;
}

export interface QuiescenceDetector {
  readonly state: AgentState;
  readonly quietSince: number | null;
  noteOutputActivity(): void;
  dispose(): void;
}

export function createQuiescenceDetector(opts: QuiescenceOptions): QuiescenceDetector {
  const quietMs = opts.quietMs ?? QUIET_MS;
  const now = opts.now ?? Date.now;
  let state: AgentState = 'quiet';
  let quietSince: number | null = null;
  let quietTimer: ReturnType<typeof setTimeout> | null = null;

  return {
    get state() {
      return state;
    },
    get quietSince() {
      return quietSince;
    },
    noteOutputActivity() {
      if (state !== 'active') {
        state = 'active';
        quietSince = null;
        opts.onTransition(state, quietSince);
      }
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(() => {
        state = 'quiet';
        quietSince = now();
        opts.onTransition(state, quietSince);
      }, quietMs);
    },
    dispose() {
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = null;
    },
  };
}
