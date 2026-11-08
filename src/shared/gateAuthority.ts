import { stripDisplayControlChars } from './controlChars';

// §27.9.1 N9b.1 / N9b.6 / N9b.9.
export const GATE_AUTHORITIES = ['human', 'auto'] as const;
export type GateAuthority = (typeof GATE_AUTHORITIES)[number];

export function isGateAuthority(v: unknown): v is GateAuthority {
  return typeof v === 'string' && (GATE_AUTHORITIES as readonly string[]).includes(v);
}

export const AUTO_HALT_REASONS = [
  'needs-a-human',
  'loop-error',
  'interrupt-armed',
  'frozen-tests-changed',
  'frozen-check-unavailable',
  'engine-input-missing',
  'failed-effect',
  'relaunched',
  'epic-promotion',
  'approve-not-persisted',
  'stop-for-a-human',
] as const;
export type AutoHaltReason = (typeof AUTO_HALT_REASONS)[number];

type AutoHaltLetter = 'a' | 'b' | 'c' | 'd' | 'e' | 'h' | 'i' | 'j' | 'k' | 'l';

// §27.9.1 N9b.6 letters; `stop-for-a-human` is the §27.6 verdict and carries none.
const AUTO_HALT: Record<AutoHaltReason, { letter: AutoHaltLetter | null; label: string }> = {
  'needs-a-human': { letter: 'a', label: 'needs a human' },
  'loop-error': { letter: 'b', label: 'loop error or accepted failed turn' },
  'interrupt-armed': { letter: 'c', label: 'interrupt armed' },
  'frozen-tests-changed': { letter: 'd', label: 'frozen tests changed' },
  'frozen-check-unavailable': { letter: 'e', label: 'frozen check unavailable' },
  'engine-input-missing': { letter: 'h', label: 'engine input missing' },
  'failed-effect': { letter: 'i', label: 'failed effect' },
  relaunched: { letter: 'j', label: 'relaunched' },
  'epic-promotion': { letter: 'k', label: 'epic promotion' },
  'approve-not-persisted': { letter: 'l', label: 'approve did not persist' },
  'stop-for-a-human': { letter: null, label: 'stop for a human' },
};

export function autoHaltReasonLabel(reason: AutoHaltReason): string {
  return AUTO_HALT[reason].label;
}

/** §27.9.1 N9b.6/N9b.10 */
export function autoHaltReasonText(r: { reason: AutoHaltReason; detail?: string }): string {
  const letter = AUTO_HALT[r.reason].letter;
  const label = letter === null ? AUTO_HALT[r.reason].label : `(${letter}) ${AUTO_HALT[r.reason].label}`;
  return r.detail === undefined ? label : `${label}: ${r.detail}`;
}

/** A halt reason as the gate panel shows it. */
export function shownAutoHaltReason(r: { reason: AutoHaltReason; detail?: string }): string {
  return stripDisplayControlChars(autoHaltReasonText(r));
}

export function autoHaltLetter(reason: AutoHaltReason): AutoHaltLetter | null {
  return AUTO_HALT[reason].letter;
}

// §27.9.1 N9b.5(d) / N9b.6(h)–(i)
export type FailedEffectState = 'set' | 'unknown';

export function failedEffectNotice(state: FailedEffectState, detail: string): string {
  const lead = state === 'set' ? 'A gate side-effect failed earlier in this run' : 'A gate side-effect may have failed earlier in this run';
  return `${lead}: ${detail}`;
}

export function isAutoHaltReason(v: string): v is AutoHaltReason {
  return (AUTO_HALT_REASONS as readonly string[]).includes(v);
}
