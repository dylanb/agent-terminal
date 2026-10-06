// §27.9.1 N9b.1 / N9b.6 / N9b.9.
export const GATE_AUTHORITIES = ['human', 'auto'] as const;
export type GateAuthority = (typeof GATE_AUTHORITIES)[number];

export const AUTO_HALT_REASONS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'stop-for-a-human'] as const;
export type AutoHaltReason = (typeof AUTO_HALT_REASONS)[number];

export function autoHaltReasonLabel(_reason: AutoHaltReason): string {
  return '';
}
