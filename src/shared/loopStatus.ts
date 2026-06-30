// Shared "loop blocked awaiting a human" family (§19.1 / §24.2.3 T4). Consumed by BOTH the renderer
// `await` tone and the main human-needed classifier — they share this one definition so they cannot
// drift apart.

export function isHumanNeededStatus(status: string): boolean {
  // `error` is the app-only step-failed-twice status the in-app orchestrator writes (§26.3/D48); it
  // blocks on a human exactly like an awaiting-human gate, so it joins this family.
  return status.startsWith('awaiting-human') || status === 'impasse' || status === 'error';
}

// CWE-117 (§16.3): the loop `status` comes from an arbitrary repo's untrusted `state.yaml`. Strip
// control characters before it reaches any human-facing sink — the OS notification (§24.2.3 T4) and
// the audit record (§25.7) share this one definition so the two sinks cannot sanitize differently.
export function stripStatusControlChars(status: string): string {
  return status.replace(/[\x00-\x1f\x7f]/g, ' ');
}
