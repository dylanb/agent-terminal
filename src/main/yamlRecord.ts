// The shared non-null, non-array object guard for the main-process parsers (yaml LoopDef/flow/state,
// JSON monitor-events): a value is a usable record iff it is a non-null, non-array object. Arrays must
// be excluded — a sequence/array otherwise passes a bare `typeof === 'object'` and breaks field reads.
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
