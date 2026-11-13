/** `input` is uncached input only: an agent's cache reads and cache writes are their own kinds. */
export type TokenKind = 'cacheRead' | 'cacheWrite' | 'input' | 'output';

/** `some` is "partly reported": only some of the agents behind the cell logged this kind. */
export type KindCell = { reported: 'all'; n: number } | { reported: 'some'; n: number } | { reported: 'none' };

export type TokenKinds = Record<TokenKind, KindCell>;

/** `billed` is false for an entered step whose windows hold no billed call. */
export type StepTokens = { state: 'counted'; billed: boolean; kinds: TokenKinds } | { state: 'unavailable' };

/** `someStepsUnavailable` is the total the user sees marked "incomplete": it sums only the counted steps. */
export type RunTokens = { state: 'counted'; someStepsUnavailable: boolean; kinds: TokenKinds } | { state: 'unavailable' };

export const TOKEN_KINDS: readonly TokenKind[] = ['cacheRead', 'cacheWrite', 'input', 'output'];

const figure = (cell: KindCell): number => (cell.reported === 'none' ? 0 : cell.n);

export function sumCells(cells: KindCell[]): KindCell {
  const n = cells.reduce((total, cell) => total + figure(cell), 0);
  if (cells.every((cell) => cell.reported === 'all')) return { reported: 'all', n };
  if (cells.every((cell) => cell.reported === 'none')) return { reported: 'none' };
  return { reported: 'some', n };
}

/** The run total over the entered steps; `null` while none is entered. */
export function runTokens(steps: StepTokens[]): RunTokens | null {
  if (steps.length === 0) return null;
  const counted = steps.flatMap((s) => (s.state === 'counted' ? [s] : []));
  if (counted.length === 0) return { state: 'unavailable' };
  const billed = counted.flatMap((s) => (s.billed ? [s.kinds] : []));
  const sum = (kind: TokenKind): KindCell => sumCells(billed.map((k) => k[kind]));
  return {
    state: 'counted',
    someStepsUnavailable: counted.length < steps.length,
    kinds: { cacheRead: sum('cacheRead'), cacheWrite: sum('cacheWrite'), input: sum('input'), output: sum('output') },
  };
}

export function railTotal(kinds: TokenKinds): { n: number; partly: boolean } {
  return { n: TOKEN_KINDS.reduce((total, kind) => total + figure(kinds[kind]), 0), partly: TOKEN_KINDS.some((kind) => kinds[kind].reported !== 'all') };
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

export const isTokenFigure = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

function isKindCell(value: unknown): value is KindCell {
  if (!isObject(value)) return false;
  if (value.reported === 'none') return !('n' in value);
  return (value.reported === 'all' || value.reported === 'some') && isTokenFigure(value.n);
}

export function isStepTokens(value: unknown): value is StepTokens {
  if (!isObject(value)) return false;
  if (value.state === 'unavailable') return true;
  const { kinds } = value;
  return value.state === 'counted' && typeof value.billed === 'boolean' && isObject(kinds) && TOKEN_KINDS.every((kind) => isKindCell(kinds[kind]));
}
