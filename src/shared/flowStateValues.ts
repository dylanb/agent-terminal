// The value rules of a flow's inputs and repeat counts, shared by the flow-state store, the flow machine and the
// bench fixture, so a value one format accepts the others cannot read differently.

export const isStringValue = (v: unknown): v is string => typeof v === 'string';

/** §28.4 */
export const isRepeatCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;

/** The whole number a flow input holds (trimmed, digits only), or undefined. */
export function readWholeNumber(raw: string | undefined): number | undefined {
  return typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : undefined;
}
