// The shared yaml-parse guard for the main-process LoopDef/flow/state parsers: a value is a usable
// record iff it is a non-null, non-array object. Arrays must be excluded — js-yaml loads a sequence
// document as an array, which would otherwise pass a bare `typeof === 'object'` and break field reads.
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
