export interface ProcessTableLookup {
  /** Aborting it abandons the lookup. */
  readonly signal: AbortSignal;
  /** The `ps` executable to run. */
  readonly ps?: string;
}

export function readProcessTable(_lookup: ProcessTableLookup): Promise<string> {
  return Promise.resolve('');
}
