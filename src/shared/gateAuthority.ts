// §27.9.1 N9b.1 / N9b.6 / N9b.9.
export const GATE_AUTHORITIES = ['human', 'auto'] as const;
export type GateAuthority = (typeof GATE_AUTHORITIES)[number];

export function isGateAuthority(v: unknown): v is GateAuthority {
  return typeof v === 'string' && (GATE_AUTHORITIES as readonly string[]).includes(v);
}

export const AUTO_HALT_REASONS = ['a', 'b', 'c', 'd', 'e', 'h', 'i', 'j', 'k', 'l', 'stop-for-a-human'] as const;
export type AutoHaltReason = (typeof AUTO_HALT_REASONS)[number];

const AUTO_HALT_LABELS: Record<AutoHaltReason, string> = {
  a: 'needs a human',
  b: 'loop error or accepted failed turn',
  c: 'interrupt armed',
  d: 'frozen tests changed',
  e: 'frozen check unavailable',
  h: 'engine input missing',
  i: 'failed effect',
  j: 'relaunched',
  k: 'epic promotion',
  l: 'approve did not persist',
  'stop-for-a-human': 'stop for a human',
};

export function autoHaltReasonLabel(reason: AutoHaltReason): string {
  return AUTO_HALT_LABELS[reason];
}

export function isAutoHaltReason(v: string): v is AutoHaltReason {
  return (AUTO_HALT_REASONS as readonly string[]).includes(v);
}
