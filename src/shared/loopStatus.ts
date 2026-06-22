// Shared "loop blocked awaiting a human" family (§19.1 / §24.2.3 T4). Consumed by BOTH the renderer
// `await` tone and the main human-needed classifier — they share this one definition so they cannot
// drift apart.

export function isHumanNeededStatus(status: string): boolean {
  return status.startsWith('awaiting-human') || status === 'impasse';
}
