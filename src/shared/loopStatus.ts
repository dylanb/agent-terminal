// Shared "loop blocked awaiting a human" family (§19.1 / §24.2.3 T4). Consumed by BOTH the renderer
// `await` tone and the main human-needed classifier — they share this one definition so they cannot
// drift apart.

import { stripDisplayControlChars } from './controlChars';

export function isHumanNeededStatus(status: string): boolean {
  // `error` is the app-only step-failed-twice status the in-app orchestrator writes (§27.12); it
  // blocks on a human exactly like an awaiting-human gate, so it joins this family.
  return status.startsWith('awaiting-human') || status === 'impasse' || status === 'error';
}

// CWE-117 / CWE-1007 (§16.3): the loop `status` comes from an arbitrary repo's untrusted `state.yaml`;
// every human-facing sink (panel, OS notification §24.2.3 T4, audit §25.7) neutralizes it through the
// one shared strip so the sinks cannot sanitize differently.
export function stripStatusControlChars(status: string): string {
  return stripDisplayControlChars(status);
}
