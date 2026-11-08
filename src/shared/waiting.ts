/** A Waiting terminal's commands: the earliest-started command's program label, and how many others are running. */
export interface WaitingValue {
  readonly program: string;
  readonly others: number;
}

/** What the controller reports for the terminal's activity: the screen's, or Waiting while the screen is quiet. */
export type ControllerActivity =
  | { readonly activity: 'active' | 'quiet'; readonly waiting?: never }
  | { readonly activity: 'waiting'; readonly waiting: WaitingValue };

export function isWaitingValue(value: unknown): value is WaitingValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const { program, others } = value as Record<string, unknown>;
  return typeof program === 'string' && program.length > 0 && typeof others === 'number' && Number.isSafeInteger(others) && others >= 0;
}

export function waitingLabel({ program, others }: WaitingValue): string {
  return others > 0 ? `${program} +${others}` : program;
}

export function sameWaitingValue(a: WaitingValue | null, b: WaitingValue | null): boolean {
  return a === b || (a !== null && b !== null && a.program === b.program && a.others === b.others);
}
