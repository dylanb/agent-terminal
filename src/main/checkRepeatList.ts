import type { ValidateFlowResult } from './validateFlow';

export interface CheckRepeatListDeps {
  /** The caller's working directory, which a relative `<file>` resolves against. */
  cwd: () => string;
}

export type CheckRepeatListResult = ValidateFlowResult;

export function runCheckRepeatList(_operands: readonly string[], _deps: CheckRepeatListDeps): CheckRepeatListResult {
  return { exitCode: 1, stdout: '', stderr: '' };
}
