import { randomUUID } from 'node:crypto';
import type { ControllerLoopMessage } from '../shared/ipc';

const MAX_REASON_CHARS = 8 * 1024;

export const publishedLoopReason = (reason: string): string =>
  reason.length > MAX_REASON_CHARS ? `${reason.slice(0, MAX_REASON_CHARS)}…` : reason;

export interface LoopMessages {
  current(): ControllerLoopMessage | null;
  post(kind: ControllerLoopMessage['kind'], reason: string): void;
  /** Clears the message only while it is still the one shown, so a late dismissal never removes its replacement. */
  dismiss(id: string): void;
}

export function createLoopMessages(onChange: () => void): LoopMessages {
  let latest: ControllerLoopMessage | null = null;
  return {
    current: () => (latest ? { ...latest } : null),
    post(kind, reason) {
      latest = { id: randomUUID(), kind, reason: publishedLoopReason(reason) };
      onChange();
    },
    dismiss(id) {
      if (latest?.id !== id) return;
      latest = null;
      onChange();
    },
  };
}
