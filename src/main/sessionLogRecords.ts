// The session-JSONL layout is Claude Code's PRIVATE format — an external dependency the app does not
// control (§27.11).

import type { ModelTokens } from '../shared/pricing';

export const MAX_IDENTITY_CHARS = 200;
export const MAX_BANKED_MODELS = 256;
export const MAX_RECENT_IDENTITIES = 4096;

export interface SessionTurn extends ModelTokens {
  at: number;
  id: string | null;
}

export function parseTurnLine(_line: string): SessionTurn | null {
  return null;
}

export interface RunTotals {
  fold(line: string): void;
  totals(): ModelTokens[];
}

export function createRunTotals(_since?: number): RunTotals {
  return {
    fold(): void {},
    totals: () => [],
  };
}
